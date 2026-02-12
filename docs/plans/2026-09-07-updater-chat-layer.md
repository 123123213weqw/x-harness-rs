# Updater chat-layer fix

The desktop updater must participate in normal page stacking, not float above
chat menus, settings or dialogs. Remove the body-mounted host's maximum z-index;
retain its location, Shadow DOM, status state machine and explicit install
confirmation. Moving the entire control into upstream React/sidebar slots is
unnecessary for this scoped layering fix.

Verify first with a failing browser hit-test using the shipped layout overlay
CSS. Cover collapsed/expanded updater and available/downloaded states at desktop
and narrow widths. Then remove the override in source and shipped asset, refresh
the updater cache revision, and rerun existing controller/confirmation tests.
Run browser layering tests in Chromium and WebKit CI. No release or installed
application files are changed by this fix.
