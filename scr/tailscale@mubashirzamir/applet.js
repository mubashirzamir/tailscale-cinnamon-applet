const Applet = imports.ui.applet;
const PopupMenu = imports.ui.popupMenu;
const Main = imports.ui.main;
const ByteArray = imports.byteArray;
const GLib = imports.gi.GLib;
const Lang = imports.lang;
const Mainloop = imports.mainloop;
const Settings = imports.ui.settings;
const Gettext = imports.gettext;

const UUID = "tailscale@mubashirzamir";

function _(text) {
    return Gettext.dgettext(UUID, text);
}

function _runTailscale(args, callback) {
    try {
        let [ok, argv] = GLib.shell_parse_argv("pkexec tailscale " + args);
        if (!ok) {
            if (callback) callback(false, _("Failed to parse command: ") + args);
            return;
        }
        let flags = GLib.SpawnFlags.SEARCH_PATH | GLib.SpawnFlags.DO_NOT_REAP_CHILD;
        let [success, pid] = GLib.spawn_async(null, argv, null, flags, null);
        if (!success) {
            if (callback) callback(false, _("Failed to spawn tailscale"));
            return;
        }
        GLib.child_watch_add(GLib.PRIORITY_DEFAULT, pid, function(pid, status) {
            let ok = GLib.spawn_check_wait_status(status);
            if (callback) callback(ok, ok ? null : _("tailscale exited with status ") + status);
        });
    } catch (e) {
        if (callback) callback(false, String(e));
    }
}

function _getTailscaleStatus() {
    try {
        let [success, out] = GLib.spawn_command_line_sync("tailscale status --peers=false --json");
        if (!success || out.length === 0) return { state: "down", exitNode: null };
        let text = ByteArray.toString(out);
        let data = JSON.parse(text);
        if (data.Self && data.Self.Online === true) {
            if (data.ExitNodeStatus && data.ExitNodeStatus.HostName) {
                return { state: "up-exit", exitNode: data.ExitNodeStatus.HostName };
            }
            return { state: "up", exitNode: null };
        }
    } catch (e) {
        global.logError("tailscale@mubashirzamir: Failed to read status: " + e);
    }
    return { state: "down", exitNode: null };
}

function _getExitNodes() {
    try {
        let [success, out] = GLib.spawn_command_line_sync("tailscale exit-node list");
        if (!success || out.length === 0) return [];
        let text = ByteArray.toString(out);
        let lines = text.split("\n");
        let nodes = [];
        for (let i = 1; i < lines.length; i++) {
            let hostname = lines[i].split(/\s+/)[0];
            if (hostname && hostname.length > 0) {
                nodes.push(hostname);
            }
        }
        return nodes;
    } catch (e) {}
    return [];
}

class TailscaleApplet extends Applet.IconApplet {
    constructor(metadata, orientation, panelHeight, instanceId) {
        super(orientation, panelHeight, instanceId);
        this.orientation = orientation;

        this.metadata = metadata;
        this.instanceId = instanceId;

        this.activeExitNode = null;
        this.pollId = null;
        this._settleTimeout = null;
        this._commandPending = false;
        this._pendingTimeout = null;
        this._logBuffer = [];

        this._initSettings(metadata, instanceId);
        this._buildMenu();
        this._updateUI();

        if (this.auto_connect_on_load) {
            this._connectPreferred();
        }

        this._log("Applet initialized");

        Mainloop.idle_add(Lang.bind(this, function() {
            this._startPolling();
            return false;
        }));
    }

    _log(message) {
        global.log("tailscale@mubashirzamir: " + message);
        this._logBuffer.push({ text: message, isError: false });
        if (this._logBuffer.length > 20) this._logBuffer.shift();
    }

    _logError(message) {
        global.logError("tailscale@mubashirzamir: " + message);
        this._logBuffer.push({ text: message, isError: true });
        if (this._logBuffer.length > 20) this._logBuffer.shift();
    }

    _initSettings(metadata, instanceId) {
        this.settings = new Settings.AppletSettings(this, metadata.uuid, instanceId);
        this.settings.bindProperty(Settings.BindingDirection.IN, "poll_interval", "poll_interval", this._onPollIntervalChanged.bind(this), null);
        this.settings.bindProperty(Settings.BindingDirection.IN, "preferred_exit_node", "preferred_exit_node", null, null);
        this.settings.bindProperty(Settings.BindingDirection.IN, "auto_connect_on_load", "auto_connect_on_load", null, null);
        this.settings.bindProperty(Settings.BindingDirection.IN, "show_debug", "show_debug", null, null);
    }

    _onPollIntervalChanged() {
        if (this.pollId) {
            this._log("Poll interval changed to " + this.poll_interval + "s");
            this._startPolling();
        }
    }

    _buildMenu() {
        this.menuManager = new PopupMenu.PopupMenuManager(this);
        this.menu = new Applet.AppletPopupMenu(this, this.orientation);
        this.menuManager.addMenu(this.menu);

        this.menu.actor.style = "min-width: 220px";

        this.switchItem = new PopupMenu.PopupSwitchMenuItem(_("Tailscale"), false);
        this.switchItem.connect("toggled", Lang.bind(this, this._onToggle));
        this.menu.addMenuItem(this.switchItem);

        this.statusItem = new PopupMenu.PopupMenuItem("");
        this.statusItem.setSensitive(false);
        this.statusItem.actor.hide();
        this.menu.addMenuItem(this.statusItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this.exitNodeParent = new PopupMenu.PopupSubMenuMenuItem(_("Select exit node"));
        this.menu.addMenuItem(this.exitNodeParent);

        this.debugParent = new PopupMenu.PopupSubMenuMenuItem(_("Debug"));
        this.debugParent.actor.hide();
        this.menu.addMenuItem(this.debugParent);

        this._refreshExitNodes();
    }

    _onToggle(item) {
        this._commandPending = true;
        this.set_applet_tooltip(item.state ? _("Connecting...") : _("Disconnecting..."));
        this.statusItem.label.set_text(item.state ? _("Connecting...") : _("Disconnecting..."));
        this.statusItem.actor.show();

        if (this._pendingTimeout) {
            Mainloop.source_remove(this._pendingTimeout);
        }
        this._pendingTimeout = Mainloop.timeout_add_seconds(30, Lang.bind(this, function() {
            this._pendingTimeout = null;
            this._commandPending = false;
            this.statusItem.actor.hide();
            this._log("Cleared pending state after timeout");
            return false;
        }));

        let pendingDone = Lang.bind(this, function() {
            if (this._pendingTimeout) {
                Mainloop.source_remove(this._pendingTimeout);
                this._pendingTimeout = null;
            }
            this.statusItem.actor.hide();
            this._commandPending = false;
        });

        if (item.state) {
            if (this.activeExitNode) {
                _runTailscale("up --exit-node=" + this.activeExitNode + " --exit-node-allow-lan-access=true --accept-routes", Lang.bind(this, function(ok, msg) {
                    pendingDone();
                    if (!ok) {
                        this._showError(msg);
                    } else {
                        this._log("Connected via exit node: " + this.activeExitNode);
                    }
                    this._scheduleUIUpdate(2);
                }));
            } else {
                _runTailscale("up --reset --accept-routes", Lang.bind(this, function(ok, msg) {
                    pendingDone();
                    if (!ok) {
                        this._showError(msg);
                    } else {
                        this._log("Connected");
                    }
                    this._scheduleUIUpdate(2);
                }));
            }
        } else {
            _runTailscale("down", Lang.bind(this, function(ok, msg) {
                pendingDone();
                if (!ok) {
                    this._showError(msg);
                } else {
                    this._log("Disconnected");
                }
                this._scheduleUIUpdate(2);
            }));
        }
    }

    _connectPreferred() {
        let node = (this.preferred_exit_node || "").trim();
        if (node) {
            _runTailscale("up --exit-node=" + node + " --exit-node-allow-lan-access=true --accept-routes", Lang.bind(this, function(ok, msg) {
                if (!ok) {
                    this._logError(msg || _("Failed to connect with preferred exit node"));
                } else {
                    this._log("Auto-connected via preferred exit node: " + node);
                }
                this._scheduleUIUpdate(2);
            }));
        } else {
            _runTailscale("up --reset --accept-routes", Lang.bind(this, function(ok, msg) {
                if (!ok) {
                    this._logError(msg || _("Failed to connect"));
                } else {
                    this._log("Auto-connected");
                }
                this._scheduleUIUpdate(2);
            }));
        }
    }

    _refreshExitNodes() {
        let nodes = _getExitNodes();
        let submenu = this.exitNodeParent.menu;

        submenu.removeAll();

        for (let i = 0; i < nodes.length; i++) {
            let hostname = nodes[i];
            let item = new PopupMenu.PopupMenuItem(hostname);
            if (hostname === this.activeExitNode) {
                item.setOrnament(PopupMenu.Ornament.CHECK);
            }
            item.connect("activate", Lang.bind(this, function() {
                let selected = hostname;
                _runTailscale("up --exit-node=" + selected + " --exit-node-allow-lan-access=true --accept-routes", Lang.bind(this, function(ok, msg) {
                    if (!ok) {
                        this._showError(msg);
                    } else {
                        this._log("Connected via exit node: " + selected);
                    }
                    this._scheduleUIUpdate(2);
                }));
            }));
            submenu.addMenuItem(item);
        }

        if (nodes.length === 0) {
            let hint = new PopupMenu.PopupMenuItem(_("No exit nodes available"));
            hint.setSensitive(false);
            submenu.addMenuItem(hint);
        }
    }

    _updateUI() {
        let status = _getTailscaleStatus();
        let iconName;

        switch (status.state) {
            case "up":
                iconName = "tailscale-on-symbolic.svg";
                this.set_applet_tooltip(_("Tailscale: On"));
                break;
            case "up-exit":
                iconName = "tailscale-exit-symbolic.svg";
                this.set_applet_tooltip(_("Tailscale: On (exit node)"));
                break;
            default:
                iconName = "tailscale-off-symbolic.svg";
                this.set_applet_tooltip(_("Tailscale: Off"));
        }

        if (this._prevIcon !== iconName) {
            this._log("State changed: " + status.state + (status.exitNode ? " (" + status.exitNode + ")" : ""));
        }
        this._prevIcon = iconName;

        this.activeExitNode = status.exitNode || null;
        this.set_applet_icon_symbolic_path(this.metadata.path + "/icons/" + iconName);

        if (this.switchItem) {
            this.switchItem.setToggleState(status.state !== "down");
        }

        this._commandPending = false;
        this.statusItem.actor.hide();
    }

    _scheduleUIUpdate(delaySeconds) {
        if (this._settleTimeout) {
            Mainloop.source_remove(this._settleTimeout);
        }
        this._settleTimeout = Mainloop.timeout_add_seconds(delaySeconds, Lang.bind(this, function() {
            this._updateUI();
            this._settleTimeout = null;
            return false;
        }));
    }

    _showError(message) {
        if (message) {
            this._logError(message);
            this.set_applet_tooltip(_("Error: ") + message);
        }
    }

    _refreshDebug() {
        if (this.show_debug) {
            this.debugParent.actor.show();
            let submenu = this.debugParent.menu;
            submenu.removeAll();
            for (let i = 0; i < this._logBuffer.length; i++) {
                let entry = this._logBuffer[i];
                let item = new PopupMenu.PopupMenuItem(entry.text);
                item.setSensitive(false);
                submenu.addMenuItem(item);
            }
            if (this._logBuffer.length === 0) {
                let item = new PopupMenu.PopupMenuItem(_("No log entries"));
                item.setSensitive(false);
                submenu.addMenuItem(item);
            }
        } else {
            this.debugParent.actor.hide();
        }
    }

    _startPolling() {
        this._stopPolling();
        let interval = typeof this.poll_interval === "number" ? this.poll_interval : 60;
        interval = Math.max(10, Math.min(120, interval));

        this.pollId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, interval, Lang.bind(this, function() {
            this._updateUI();
            return true;
        }));
    }

    _stopPolling() {
        if (this.pollId) {
            GLib.source_remove(this.pollId);
            this.pollId = null;
        }
        if (this._settleTimeout) {
            Mainloop.source_remove(this._settleTimeout);
            this._settleTimeout = null;
        }
        if (this._pendingTimeout) {
            Mainloop.source_remove(this._pendingTimeout);
            this._pendingTimeout = null;
        }
        this._commandPending = false;
    }

    on_applet_clicked(event) {
        let status = _getTailscaleStatus();
        this.switchItem.setToggleState(status.state !== "down");
        this.statusItem.actor.hide();
        this._commandPending = false;
        this._refreshExitNodes();
        this._refreshDebug();
        this.menu.toggle();
    }

    on_applet_removed_from_panel() {
        this._stopPolling();
    }
}

function main(metadata, orientation, panelHeight, instanceId) {
    try {
        return new TailscaleApplet(metadata, orientation, panelHeight, instanceId);
    } catch (e) {
        global.logError("tailscale@mubashirzamir: Failed to start applet: " + e);
        throw e;
    }
}
