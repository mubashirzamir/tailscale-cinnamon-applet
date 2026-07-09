# Tailscale Cinnamon applet

This applet allows seeing Tailscale state in the Cinnamon taskbar.

States are: down, up, up with exit node.

The user can change state from the applet.

## Installation in Linux Mint Cinnamon

1. Copy the applet files in:
```/usr/share/cinnamon/applets/tailscale@mubashirzamir```
Or, if you want an installation for the current user only, in:
```$HOME/.local/share/cinnamon/applets/tailscale@mubashirzamir```

2. Restart Cinnamon:
Alt+F2 -> enter the command: r

3. Add the applet in the taskbar:
Right click on the taskbar -> Applets

## Configuration

Right-click the applet -> Configure to set:

- **Poll interval**: seconds between Tailscale state refreshes (10-120, default 60)
- **Preferred exit node**: hostname of your default exit node (leave empty for none)
- **Auto-connect on load**: run `tailscale up` when the applet starts
