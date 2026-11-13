{{title}}

{{files}}

{{signing}}

`SHA256SUMS` lists the SHA-256 checksum of every file above. Checking a download against it is optional, and shows
the file arrived exactly as it was built.

## Installing on Windows

1. Download `{{win_installer}}`, and `SHA256SUMS` if you want to check it.
2. To check the download, open PowerShell in your Downloads folder and run:

   ```powershell
   Get-FileHash .\{{win_installer}} -Algorithm SHA256
   ```

   The hash it prints must match the line for `{{win_installer}}` in `SHA256SUMS` (PowerShell prints it in capital
   letters; that is fine).

3. Run the installer.
{{#if win_unsigned}}
   If Windows shows "Windows protected your PC", click **More info**, then **Run anyway**. Windows shows this because
   the installer is not signed with a paid certificate, not because anything is wrong with it.
{{/if}}

## Installing on macOS

1. Download the dmg for your Mac: `{{mac_arm64_dmg}}` for Apple silicon (M1 and later), or `{{mac_x64_dmg}}` for
   Intel. Not sure? Apple menu, About This Mac: "Chip" means Apple silicon, "Processor" means Intel.
2. To check the download, open Terminal in your Downloads folder and run:

   ```sh
   shasum -a 256 --check --ignore-missing SHA256SUMS
   ```

   It prints `OK` next to each file you downloaded.

3. Open the dmg and drag {{name}} to Applications.
{{#if mac_unsigned}}
4. Open {{name}} from Applications. The first time, macOS blocks it because the app is not notarized by Apple. Click
   **Done**.
5. Open System Settings, then Privacy & Security. Scroll down to the message about {{name}} and click **Open
   Anyway**, then enter your password. You only do this once; after that {{name}} opens normally.

Homebrew's main cask list does not accept apps that are not signed and notarized, so there is no
`brew install --cask` for {{name}} yet.
{{/if}}

## Installing on Linux

Ubuntu and Debian (the deb is the recommended package):

```sh
sudo apt install ./{{deb}}
```

Other distributions (the AppImage):

```sh
chmod +x {{appimage}}
./{{appimage}}
```

The AppImage needs FUSE 2 (`libfuse2t64` on Ubuntu 24.04). On Ubuntu 24.04 and later, use the deb: it installs the
AppArmor profile that Chromium's sandbox needs, which an AppImage cannot carry.

To check the downloads, put them in one folder with `SHA256SUMS` and run:

```sh
sha256sum -c SHA256SUMS
```

With only some of the files downloaded, add `--ignore-missing`.

{{built_from}}
