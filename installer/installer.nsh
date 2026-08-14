!include "FileFunc.nsh"
!include "LogicLib.nsh"
!include "nsDialogs.nsh"

!define INSTALL_REGISTRY_KEY "Software\AuthorityGate\RackSight"

!ifndef BUILD_UNINSTALLER
!include "StrContains.nsh"
Var RackSightEmail
Var RackSightEmailInput
Var RackSightValidationLabel

Function RackSightValidateEmail
  StrCpy $R8 ""
  ${If} $RackSightEmail == ""
    StrCpy $R8 "Enter an email address to continue."
    Return
  ${EndIf}
  ${StrContains} $R9 "@" $RackSightEmail
  ${If} $R9 == ""
    StrCpy $R8 "Enter a valid email address."
    Return
  ${EndIf}
  ${StrContains} $R9 "." $RackSightEmail
  ${If} $R9 == ""
    StrCpy $R8 "Enter a valid email address."
  ${EndIf}
FunctionEnd

Function RackSightOpenLicenseSite
  ExecShell "open" "https://license.authoritygate.com"
FunctionEnd

Function RackSightOpenGitHub
  ExecShell "open" "https://github.com/AuthorityGate/RackSight"
FunctionEnd

Function RackSightRegistrationPageCreate
  ${If} ${Silent}
    Abort
  ${EndIf}
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 20u "RackSight installation registration"
  Pop $0
  CreateFont $1 "Segoe UI" 12 700
  SendMessage $0 ${WM_SETFONT} $1 1

  ${NSD_CreateLabel} 0 28u 100% 26u "Enter an email address. RackSight will attempt to send it with this computer's FQDN and the installed app version to AuthorityGate."
  Pop $0
  ${NSD_CreateText} 0 60u 100% 13u "$RackSightEmail"
  Pop $RackSightEmailInput
  ${NSD_CreateLabel} 0 78u 100% 12u ""
  Pop $RackSightValidationLabel
  SetCtlColors $RackSightValidationLabel 0xB00020 transparent

  ${NSD_CreateLabel} 0 97u 100% 28u "This is install registration only. RackSight has no license key, activation requirement, feature restriction, or network dependency. If the service cannot be reached, setup continues normally."
  Pop $0
  ${NSD_CreateLabel} 0 133u 100% 12u "AuthorityGate license and registration service"
  Pop $0
  SetCtlColors $0 0x0057B8 transparent
  ${NSD_OnClick} $0 RackSightOpenLicenseSite
  ${NSD_CreateLabel} 0 150u 100% 12u "RackSight source and releases on GitHub"
  Pop $0
  SetCtlColors $0 0x0057B8 transparent
  ${NSD_OnClick} $0 RackSightOpenGitHub
  nsDialogs::Show
FunctionEnd

Function RackSightRegistrationPageLeave
  ${NSD_GetText} $RackSightEmailInput $RackSightEmail
  Call RackSightValidateEmail
  ${If} $R8 != ""
    ${NSD_SetText} $RackSightValidationLabel $R8
    Abort
  ${EndIf}
FunctionEnd

!macro customInit
  SetRegView 64
  ReadRegStr $RackSightEmail HKLM "${INSTALL_REGISTRY_KEY}" "RegistrationEmail"
  ${GetParameters} $R0
  ${GetOptions} $R0 "/RACKSIGHTEMAIL=" $R1
  ${IfNot} ${Errors}
    StrCpy $RackSightEmail $R1
  ${EndIf}
  ${If} ${Silent}
    Call RackSightValidateEmail
    ${If} $R8 != ""
      MessageBox MB_ICONSTOP "Silent setup requires /RACKSIGHTEMAIL=user@example.com."
      Abort
    ${EndIf}
  ${EndIf}
!macroend

!macro customPageAfterChangeDir
  Page custom RackSightRegistrationPageCreate RackSightRegistrationPageLeave
!macroend

!macro customInstall
  SetRegView 64
  WriteRegStr HKLM "${INSTALL_REGISTRY_KEY}" "Publisher" "AuthorityGate"
  WriteRegStr HKLM "${INSTALL_REGISTRY_KEY}" "ProductName" "RackSight"
  WriteRegStr HKLM "${INSTALL_REGISTRY_KEY}" "Version" "${VERSION}"
  WriteRegStr HKLM "${INSTALL_REGISTRY_KEY}" "RegistrationEmail" "$RackSightEmail"
  WriteRegStr HKLM "${INSTALL_REGISTRY_KEY}" "RegistrationEndpoint" "https://license.authoritygate.com/api/racksight/installations"
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\registration\register-installation.ps1"'
!macroend
!endif

!macro customUnInstall
  SetRegView 64
  DeleteRegKey HKLM "Software\AuthorityGate\RackSight"
!macroend
