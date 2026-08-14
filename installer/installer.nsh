!include "FileFunc.nsh"
!include "LogicLib.nsh"
!include "nsDialogs.nsh"

!define INSTALL_REGISTRY_KEY "Software\AuthorityGate\RackSight"

!ifndef BUILD_UNINSTALLER
!include "StrContains.nsh"
Var RackSightEmail
Var RackSightEmailInput
Var RackSightCompany
Var RackSightCompanyInput
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

Function RackSightValidateCompany
  ${If} $RackSightCompany == ""
    StrCpy $R8 "Enter a company name to continue."
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

  ${NSD_CreateLabel} 0 28u 100% 26u "Confirm the company name detected from Windows registration and enter an email address. RackSight will send them with this computer's FQDN and app version to AuthorityGate."
  Pop $0
  ${NSD_CreateLabel} 0 58u 28% 12u "Company name"
  Pop $0
  ${NSD_CreateText} 29% 56u 71% 13u "$RackSightCompany"
  Pop $RackSightCompanyInput
  ${NSD_CreateLabel} 0 77u 28% 12u "Email address"
  Pop $0
  ${NSD_CreateText} 29% 75u 71% 13u "$RackSightEmail"
  Pop $RackSightEmailInput
  ${NSD_CreateLabel} 0 93u 100% 12u ""
  Pop $RackSightValidationLabel
  SetCtlColors $RackSightValidationLabel 0xB00020 transparent

  ${NSD_CreateLabel} 0 108u 100% 28u "This is install registration only. RackSight has no license key, activation requirement, feature restriction, or network dependency. If the service cannot be reached, setup continues normally."
  Pop $0
  ${NSD_CreateLabel} 0 141u 100% 12u "AuthorityGate license and registration service"
  Pop $0
  SetCtlColors $0 0x0057B8 transparent
  ${NSD_OnClick} $0 RackSightOpenLicenseSite
  ${NSD_CreateLabel} 0 158u 100% 12u "RackSight source and releases on GitHub"
  Pop $0
  SetCtlColors $0 0x0057B8 transparent
  ${NSD_OnClick} $0 RackSightOpenGitHub
  nsDialogs::Show
FunctionEnd

Function RackSightRegistrationPageLeave
  ${NSD_GetText} $RackSightEmailInput $RackSightEmail
  ${NSD_GetText} $RackSightCompanyInput $RackSightCompany
  Call RackSightValidateEmail
  ${If} $R8 != ""
    ${NSD_SetText} $RackSightValidationLabel $R8
    Abort
  ${EndIf}
  Call RackSightValidateCompany
  ${If} $R8 != ""
    ${NSD_SetText} $RackSightValidationLabel $R8
    Abort
  ${EndIf}
FunctionEnd

!macro customInit
  SetRegView 64
  ReadRegStr $RackSightEmail HKLM "${INSTALL_REGISTRY_KEY}" "RegistrationEmail"
  ReadRegStr $RackSightCompany HKLM "${INSTALL_REGISTRY_KEY}" "RegistrationCompany"
  ${If} $RackSightCompany == ""
    ReadRegStr $RackSightCompany HKLM "Software\Microsoft\Windows NT\CurrentVersion" "RegisteredOrganization"
  ${EndIf}
  ${If} $RackSightCompany == ""
    ReadEnvStr $R2 "USERDNSDOMAIN"
    ${If} $R2 != ""
      StrCpy $RackSightCompany $R2
    ${EndIf}
  ${EndIf}
  ${If} $RackSightCompany == ""
    ReadEnvStr $R2 "USERDOMAIN"
    ReadEnvStr $R3 "COMPUTERNAME"
    ${If} $R2 != ""
      ${If} $R2 != $R3
        ${If} $R2 != "WORKGROUP"
          ${If} $R2 != "AzureAD"
            StrCpy $RackSightCompany $R2
          ${EndIf}
        ${EndIf}
      ${EndIf}
    ${EndIf}
  ${EndIf}
  ${GetParameters} $R0
  ${GetOptions} $R0 "/RACKSIGHTEMAIL=" $R1
  ${IfNot} ${Errors}
    StrCpy $RackSightEmail $R1
  ${EndIf}
  ${GetOptions} $R0 "/RACKSIGHTCOMPANY=" $R1
  ${IfNot} ${Errors}
    StrCpy $RackSightCompany $R1
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
  WriteRegStr HKLM "${INSTALL_REGISTRY_KEY}" "RegistrationCompany" "$RackSightCompany"
  WriteRegStr HKLM "${INSTALL_REGISTRY_KEY}" "RegistrationEndpoint" "https://license.authoritygate.com/api/racksight/installations"
  ${If} $RackSightEmail != ""
  ${AndIf} $RackSightCompany != ""
    nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\registration\register-installation.ps1"'
  ${EndIf}
!macroend
!endif

!macro customUnInstall
  SetRegView 64
  DeleteRegKey HKLM "Software\AuthorityGate\RackSight"
!macroend
