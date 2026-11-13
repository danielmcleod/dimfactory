#!/bin/bash
# deb postrm for Dim Factory: undoes build/linux/after-install.sh. dpkg also runs postrm
# during an upgrade, before the new version's postinst; that postinst reinstalls everything, so upgrades skip it.
# electron-builder expands dollar-brace macros in this file, so shell variables are written without braces.

case "$1" in
  upgrade | failed-upgrade | abort-install | abort-upgrade) exit 0 ;;
esac

INSTALL_DIR='/opt/Dim Factory'
EXECUTABLE='dim-factory'
PROFILE_TARGET="/etc/apparmor.d/$EXECUTABLE"

if type update-alternatives >/dev/null 2>&1; then
  # --remove takes the registered target, not the /usr/bin link.
  update-alternatives --remove "$EXECUTABLE" "$INSTALL_DIR/$EXECUTABLE" || true
else
  rm -f "/usr/bin/$EXECUTABLE"
fi

if [ -f "$PROFILE_TARGET" ]; then
  # Unload before deleting so the policy does not stay in the kernel until reboot (not in a chroot).
  if ! { [ -x /usr/bin/ischroot ] && /usr/bin/ischroot; } && hash apparmor_parser 2>/dev/null; then
    apparmor_parser --remove "$PROFILE_TARGET" >/dev/null 2>&1 || true
  fi
  rm -f "$PROFILE_TARGET"
fi

exit 0
