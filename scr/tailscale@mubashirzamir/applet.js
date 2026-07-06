/* TODO(1): add gettext translation wrapper once we finalize strings.
 * TODO(2): confirm polkit behavior; keep direct tailscale or wrap with root helper.
 * TODO(3): extend exit-node picker to dynamic list via `tailscale exit-node list`.
 * TODO(4): remove legacy .env support; move exit-node config to cinnamon settings schema.
 * TODO(5): add cinnamon settings schema.json for official Spices submission.
 */
const Applet = imports.ui.applet;
const PopupMenu = imports.ui.popupMenu;
const Util = imports.misc.util;
const GLib = imports.gi.GLib;
const Mainloop = imports.mainloop;
const Settings = imports.ui.settings;

const UUID = "tailscale@mubashirzamir";
const HOME_DIR = GLib.get_home_dir();

// TODO(1): Replace with proper gettext setup + .pot/.po once translations are added.
function _(text) {
    return text;
}

// TODO(2): Once we confirm Mint/Tailscale polkit behavior, either remove
// this entirely or turn it into a small wrapper.
function _runTailscale(args) {
    let [ok, out, err, status] = GLib.spawn_command_line_sync(
        "tailscale " + args + " 2>&1"
    );
    return ok;
}

function _getTailscaleState() {
    let [success, out, err, status] = GLib.spawn_command_line_sync(
        "tailscale status --peers=false --json 2>/dev/null"
    );
    if (!success || out.length === 0) {
        return "down";
    }

    let text = GLib.convert(out, -1, "UTF-8", null)[1];
    try {
        let data = JSON.parse(text);
        if (data.Self && data.Self.Online === true) {
            if (data.ExitNodeStatus) {
                return "up-exit";
            }
            return "up";
        }
    } catch (e) {
        // fall through
    }
    return "down";
}

function _iconPath(appletDir, state) {
    let names = {
        "down": "tailscale-off-symbolic.svg",
        "up": "tailscale-on-symbolic.svg",
        "up-exit": "tailscale-exit-symbolic.svg"
    };
    return appletDir + "/icons/" + (names[state] || names["down"]);
}

function TailscaleApplet(orientation, panelHeight, instanceId) {
    this._init(orientation, panelHeight, instanceId);
}

TailscaleApplet.prototype = {
    __proto__: Applet.IconApplet.prototype,

    _init: function(orientation, panelHeight, instanceId) {
        Applet.IconApplet.prototype._init.call(this, orientation, panelHeight, instanceId);

        this.appletDir = null; // set by main()
        this.state = "down";
        this.pollId = null;
        this._settleTimeout = null;

        this._loadSettings();
        this._buildMenu();
        this._updateUI();

        if (this.settings.getValue("auto_connect_on_load")) {
            this._connectPreferred();
        }
    },

    on_applet_removed_from_panel: function() {
        this._stopPolling();
    },

    // ------- Settings -------------------------------------------------

    _loadSettings: function() {
        // TODO(5): schema file exists; for now also provide a fallback if
        // Cinnamon doesn't read settings-schema.json.
        this.settings = new Settings.AppletSettings(this, UUID, this._instanceId || "0");
        this.settings.bindProperty(Settings.BindingDirection.IN, "poll_interval", "poll_interval", null, null);
        this.settings.bindProperty(Settings.BindingDirection.IN, "preferred_exit_node", "preferred_exit_node", null, null);
        this.settings.bindProperty(Settings.BindingDirection.IN, "auto_connect_on_load", "auto_connect_on_load", null, null);
    },

    // ------- Menu ----------------------------------------------------

    _buildMenu: function() {
        this.menuManager = new PopupMenu.PopupMenuManager(this);
        this.menu = new Applet.AppletPopupMenu(this, this.meta.orientation);
        this.menuManager.addMenu(this.menu);

        this.switchItem = new PopupMenu.PopupSwitchMenuItem(_("Tailscale"), false);
        this.switchItem.connect('toggled', Lang.bind(this, this._onToggle));
        this.menu.addMenuItem(this.switchItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this.noExitItem = new PopupMenu.PopupMenuItem(_("Connect without exit node"));
        this.noExitItem.connect('activate', Lang.bind(this, function() {
            _runTailscale("up --reset --accept-routes");
            this._scheduleUIUpdate(2);
        }));
        this.menu.addMenuItem(this.noExitItem);

        this.exitItem = new PopupMenu.PopupMenuItem(_("Connect via preferred exit node"));
        this.exitItem.connect('activate', Lang.bind(this, function() {
            this._connectPreferred();
        }));
        this.menu.addMenuItem(this.exitItem);

        this.disconnectItem = new PopupMenu.PopupMenuItem(_("Disconnect"));
        this.disconnectItem.connect('activate', Lang.bind(this, function() {
            _runTailscale("down");
            this._scheduleUIUpdate(2);
        }));
        this.menu.addMenuItem(this.disconnectItem);
    },

    _connectPreferred: function() {
        let node = (this.preferred_exit_node || "").trim();
        if (!node) {
            _runTailscale("up --reset --accept-routes");
        } else {
            _runTailscale("up --exit-node=" + node + " --exit-node-allow-lan-access=true --accept-routes");
        }
        this._scheduleUIUpdate(2);
    },

    _onToggle: function(item) {
        let cmd = item.state
            ? "tailscale up --reset --accept-routes"
            : "tailscale down";
        _runTailscale(cmd);
        this._scheduleUIUpdate(2);
    },

    on_applet_clicked: function(event) {
        let state = _getTailscaleState();
        this.switchItem.setToggleState(state !== "down");
        this.menu.toggle();
    },

    // ------- UI update ---------------------------------------------

    _updateUI: function() {
        if (!this.appletDir) return;

        this.state = _getTailscaleState();
        this.set_applet_icon_symbolic_path(_iconPath(this.appletDir, this.state));

        // TODO(1): replace hardcoded tooltips with _() translations once we add gettext.
        let tooltip = this.state === "up"
            ? "Tailscale: On"
            : (this.state === "up-exit" ? "Tailscale: On (exit node)" : "Tailscale: Off");
        this.set_applet_tooltip(tooltip);

        if (this.switchItem) {
            this.switchItem.setToggleState(this.state !== "down");
        }
    },

    _scheduleUIUpdate: function(delaySeconds) {
        if (this._settleTimeout) {
            Mainloop.source_remove(this._settleTimeout);
        }
        this._settleTimeout = Mainloop.timeout_add_seconds(
            delaySeconds,
            Lang.bind(this, function() {
                this._updateUI();
                this._settleTimeout = null;
                return false;
            })
        );
    },

    // ------- Polling -----------------------------------------------

    startPolling: function() {
        this._stopPolling();
        let interval = typeof this.poll_interval === "number" ? this.poll_interval : 60;
        interval = Math.max(10, Math.min(120, interval));

        this.pollId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            interval,
            Lang.bind(this, function() {
                this._updateUI();
                return true;
            })
        );
    },

    _stopPolling: function() {
        if (this.pollId) {
            GLib.source_remove(this.pollId);
            this.pollId = null;
        }
    }
};

function main(metadata, orientation, panelHeight, instanceId) {
    let applet = new TailscaleApplet(orientation, panelHeight, instanceId);
    applet.meta = metadata;
    applet.appletDir = metadata.path;
    applet._instanceId = instanceId;
    applet.startPolling();
    return applet;
}
