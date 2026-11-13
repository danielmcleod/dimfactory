; Dim Factory NSIS include. An ask's toast actions (Allow, Deny) need the AUMID and the ToastActivatorCLSID on the
; Start-menu shortcut. electron-builder creates the shortcut and sets its AUMID (WinShell::SetLnkAUMI); this adds
; System.AppUserModel.ToastActivatorCLSID, so Windows routes a click in Action Center to Electron's COM activator (Notification.handleActivation). Electron 44 registers that
; activator itself at runtime (HKCU\Software\Classes\CLSID\{CLSID}\LocalServer32), so nothing is registered here;
; the uninstaller removes what it left behind. src/main/shortcut.ts repairs the shortcut at runtime as well.

; Must equal TOAST_ACTIVATOR_CLSID in src/main/constants.ts (a unit test keeps them equal).
!define DIM_FACTORY_TOAST_CLSID "{5623D05F-66EA-4E4C-993F-A156F0425595}"

!define DIM_FACTORY_CLSID_ShellLink "{00021401-0000-0000-C000-000000000046}"
!define DIM_FACTORY_IID_IShellLinkW "{000214F9-0000-0000-C000-000000000046}"
!define DIM_FACTORY_IID_IPersistFile "{0000010b-0000-0000-C000-000000000046}"
!define DIM_FACTORY_IID_IPropertyStore "{886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99}"
; PKEY_AppUserModel_ToastActivatorCLSID = {9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3}, 26
!define DIM_FACTORY_PKEY_AUMODEL_FMTID "{9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3}"
!define DIM_FACTORY_PKEY_TOAST_PID 26
; PROPVARIANT vt for a CLSID pointer
!define DIM_FACTORY_VT_CLSID 72

; Writes the toast activator CLSID into an existing .lnk through IShellLinkW + IPropertyStore (what WinShell does
; for the AUMID). COM vtable slots: IUnknown 0 QueryInterface, 2 Release; IPersistFile 5 Load, 6 Save;
; IPropertyStore 6 SetValue, 7 Commit. Leaves $0..$6 as they were.
!macro dimFactorySetLnkToastClsid LNK
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  Push $6
  StrCpy $1 0
  StrCpy $2 0
  StrCpy $3 0
  System::Call 'ole32::CoCreateInstance(g "${DIM_FACTORY_CLSID_ShellLink}", p 0, i 1, g "${DIM_FACTORY_IID_IShellLinkW}", *p .r1) i .r0'
  ${If} $0 = 0
    System::Call '$1->0(g "${DIM_FACTORY_IID_IPersistFile}", *p .r2) i .r0'
    ${If} $0 = 0
      ; STGM_READWRITE
      System::Call '$2->5(w "${LNK}", i 2) i .r0'
      ${If} $0 = 0
        System::Call '$1->0(g "${DIM_FACTORY_IID_IPropertyStore}", *p .r3) i .r0'
        ${If} $0 = 0
          System::Call '*(&g16 "${DIM_FACTORY_TOAST_CLSID}") p .r4'
          ; PROPVARIANT: vt, three reserved WORDs, then the union (puuid); padded to the x64 size
          System::Call '*(&i2 ${DIM_FACTORY_VT_CLSID}, &i2 0, &i2 0, &i2 0, p r4, p 0) p .r5'
          System::Call '*(&g16 "${DIM_FACTORY_PKEY_AUMODEL_FMTID}", i ${DIM_FACTORY_PKEY_TOAST_PID}) p .r6'
          System::Call '$3->6(p r6, p r5) i .r0'
          ${If} $0 = 0
            System::Call '$3->7() i .r0'
          ${EndIf}
          System::Free $6
          System::Free $5
          System::Free $4
          System::Call '$3->2()'
          ${If} $0 = 0
            ; IPersistFile::Save(NULL, TRUE): back to the file it was loaded from
            System::Call '$2->6(p 0, i 1) i .r0'
          ${EndIf}
        ${EndIf}
      ${EndIf}
      System::Call '$2->2()'
    ${EndIf}
    System::Call '$1->2()'
  ${EndIf}
  ${IfNot} $0 = 0
    DetailPrint "Dim Factory: the Start menu shortcut has no toast activator ($0); the app repairs it at launch."
  ${EndIf}
  Pop $6
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
!macroend

!macro customInstall
  ${If} ${FileExists} "$newStartMenuLink"
    ; Again, in case the shortcut was kept from an earlier install (keepShortcuts) without it.
    WinShell::SetLnkAUMI "$newStartMenuLink" "${APP_ID}"
    !insertmacro dimFactorySetLnkToastClsid "$newStartMenuLink"
    System::Call 'shell32::SHChangeNotify(i 0x8000000, i 0, p 0, p 0)'
  ${EndIf}
!macroend

!macro customUnInstall
  ${IfNot} ${isUpdated}
    ; Electron's runtime registration of the toast activator, and its AUMID entry if it wrote one.
    DeleteRegKey HKCU "Software\Classes\CLSID\${DIM_FACTORY_TOAST_CLSID}"
    DeleteRegKey HKCU "Software\Classes\AppUserModelId\${APP_ID}"
  ${EndIf}
!macroend
