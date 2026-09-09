#!/bin/bash

# Replaces electron-builder's default after-install template: no chrome-sandbox
# chmod (afterPack deletes that file — the app runs via the --no-sandbox wrapper).

if type update-alternatives 2>/dev/null >&1; then
    # Remove previous link if it doesn't use update-alternatives
    if [ -L '/usr/bin/ternimal' -a -e '/usr/bin/ternimal' -a "`readlink '/usr/bin/ternimal'`" != '/etc/alternatives/ternimal' ]; then
        rm -f '/usr/bin/ternimal'
    fi
    update-alternatives --install '/usr/bin/ternimal' 'ternimal' '/opt/Ternimal/ternimal' 100 || ln -sf '/opt/Ternimal/ternimal' '/usr/bin/ternimal'
else
    ln -sf '/opt/Ternimal/ternimal' '/usr/bin/ternimal'
fi

if hash update-mime-database 2>/dev/null; then
    update-mime-database /usr/share/mime || true
fi

if hash update-desktop-database 2>/dev/null; then
    update-desktop-database /usr/share/applications || true
fi
