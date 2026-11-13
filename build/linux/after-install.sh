#!/bin/bash
# deb postinst for Dim Factory (Ubuntu 24.04+ restricts user namespaces through AppArmor). It replaces
# electron-builder's default after-install, so it keeps that script's duties (the /usr/bin link, the chrome-sandbox
# mode, desktop and MIME caches) and installs the AppArmor profile that lets Chromium's sandbox create user
# namespaces on Ubuntu 24.04+.
# electron-builder expands dollar-brace macros in this file, so shell variables are written without braces.

INSTALL_DIR='/opt/Dim Factory'
EXECUTABLE='dim-factory'
PROFILE_SOURCE="$INSTALL_DIR/resources/apparmor-profile"
PROFILE_TARGET="/etc/apparmor.d/$EXECUTABLE"

# ---- /usr/bin/dim-factory ----
if type update-alternatives >/dev/null 2>&1; then
  # Drop a plain symlink left by an older install so update-alternatives can own the name.
  if [ -L "/usr/bin/$EXECUTABLE" ] && [ -e "/usr/bin/$EXECUTABLE" ] &&
    [ "$(readlink "/usr/bin/$EXECUTABLE")" != "/etc/alternatives/$EXECUTABLE" ]; then
    rm -f "/usr/bin/$EXECUTABLE"
  fi
  update-alternatives --install "/usr/bin/$EXECUTABLE" "$EXECUTABLE" "$INSTALL_DIR/$EXECUTABLE" 100 ||
    ln -sf "$INSTALL_DIR/$EXECUTABLE" "/usr/bin/$EXECUTABLE"
else
  ln -sf "$INSTALL_DIR/$EXECUTABLE" "/usr/bin/$EXECUTABLE"
fi

# ---- AppArmor (before the sandbox decision: an installed profile makes user namespaces available) ----
profile_installed=0
if [ -f "$PROFILE_SOURCE" ] && [ -d /etc/apparmor.d ] && hash apparmor_parser 2>/dev/null; then
  # abi/4.0 needs AppArmor 4 (Ubuntu 24.04+). Older parsers reject it, and those systems do not restrict user
  # namespaces either, so the profile is simply skipped there.
  if apparmor_parser --skip-kernel-load --debug "$PROFILE_SOURCE" >/dev/null 2>&1; then
    cp -f "$PROFILE_SOURCE" "$PROFILE_TARGET"
    profile_installed=1
    # Live reload is meaningless in a chroot (image builds); the profile loads at the next boot there.
    if ! { [ -x /usr/bin/ischroot ] && /usr/bin/ischroot; } && apparmor_status --enabled >/dev/null 2>&1; then
      apparmor_parser -r --write-cache --skip-read-cache "$PROFILE_TARGET" ||
        echo "Dim Factory: could not load the AppArmor profile now; it loads at the next boot."
    fi
  else
    echo "Dim Factory: this AppArmor version does not support the bundled profile; skipping it."
  fi
fi

# ---- Chromium sandbox ----
# The SUID helper is the fallback for systems where unprivileged user namespaces are unavailable: disabled in the
# kernel, or restricted by AppArmor without our profile in place. Root's own unshare test cannot see the AppArmor
# restriction (it only applies to unprivileged processes), hence the explicit sysctl check.
userns=0
if [ -L /proc/self/ns/user ] && unshare --user true 2>/dev/null; then
  userns=1
fi
if [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null)" = "1" ] &&
  [ "$profile_installed" != "1" ]; then
  userns=0
fi
if [ "$userns" = "1" ]; then
  chmod 0755 "$INSTALL_DIR/chrome-sandbox" || true
else
  chown root:root "$INSTALL_DIR/chrome-sandbox" || true
  chmod 4755 "$INSTALL_DIR/chrome-sandbox" || true
fi

# ---- desktop integration ----
if hash update-mime-database 2>/dev/null; then
  update-mime-database /usr/share/mime || true
fi
if hash update-desktop-database 2>/dev/null; then
  update-desktop-database /usr/share/applications || true
fi

exit 0
