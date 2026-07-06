/* TODO(1): add gettext translation wrapper once we finalize strings.
 * TODO(2): confirm polkit behavior; keep direct tailscale or wrap with root helper.
 * TODO(3): add way to choose / clear exit node instead of only showing the state.
 * TODO(4): remove legacy .env support; move exit-node config to cinnamon settings schema.
 * TODO(5): add cinnamon settings schema.json for official Spices submission.
 */

const Applet = imports.ui.applet;
const PopupMenu = imports.ui.popupMenu;
const Util = imports.misc.util;
const GLib = imports.gi.GLib;
const Mainloop = imports.mainloop;

const UUID = "tailscale@mubashirzamir";
const HOME_DIR = GLib.get_home_dir();

// TODO(1): Replace with proper gettext setup + .pot/.po once translations are added.
function _(text) {
    return text;
}

// TODO(2): Once we confirm Mint/Tailscale polkit behavior, either remove
// this entirely or turn it into a small wrapper. For now, direct tailscale
// invoked from the panel works for most users because Tailscale's polkit
// rules allow the user-owned binary to manage the interface.
function _runTailscale(args) {
    let [ok, out, err, status] = GLib.spawn_command_line_sync(
        "tailscale " + args + " 2>&1"
    );
    return ok;
}

function _getTailscaleState() {
    // Returns "up", "up-exit", or "down"
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

        this.appletDir = null; // set by main() from metadata
        this.pollId = null;

        this._buildMenu();
        this._updateUI();
    },

    on_applet_removed_from_panel: function() {
        this._stopPolling();
    },

    // ------- Menu --------------------------------------------------

    _buildMenu: function() {
        this.menuManager = new PopupMenu.PopupMenuManager(this);
        this.menu = new Applet.AppletPopupMenu(this, this.meta.orientation);
        this.menuManager.addMenu(this.menu);

        this.switchItem = new PopupMenu.PopupSwitchMenuItem(_("Tailscale"), false);
        this.switchItem.connect('toggled', Lang.bind(this, this._onToggle));
        this.menu.addMenuItem(this.switchItem);
    },

    _onToggle: function(item) {
        // TODO(2): if direct invocation fails for some users, wrap with
        // a small root-helper here instead of assuming plain tailscale works.
        let cmd = item.state
            ? "tailscale up --reset --accept-routes"
            : "tailscale down";
        _runTailscale(cmd);

        // Refresh after a short settle window; Tailscale may open the
        // browser for re-auth if needed, which is handled by the CLI itself.
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

        let state = _getTailscaleState();
        this.set_applet_icon_symbolic_path(_iconPath(this.appletDir, state));

        // TODO(1): replace hardcoded tooltips with _() translations once we add gettext.
        let tooltip = state === "up"
            ? "Tailscale: On"
            : (state === "up-exit" ? "Tailscale: On (exit node)" : "Tailscale: Off");
        this.set_applet_tooltip(tooltip);

        if (this.switchItem) {
            this.switchItem.setToggleState(state !== "down");
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
        this.pollId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            60,
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
    applet.startPolling();
    return applet;
}
