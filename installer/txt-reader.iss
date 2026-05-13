#define AppName "TXT Reader"
#define AppExeName "txt-reader.exe"
#ifndef AppVersion
#define AppVersion "0.1.0"
#endif
#ifndef ProjectRoot
#define ProjectRoot ".."
#endif
#ifndef OutputDir
#define OutputDir "..\release"
#endif

[Setup]
AppId={{9E63FA93-9C4C-4E8E-9DE8-671864AD73D4}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher=TXT Reader
DefaultDirName={autopf}\TXT Reader
DefaultGroupName=TXT Reader
DisableProgramGroupPage=yes
OutputDir={#OutputDir}
OutputBaseFilename=txt-reader-{#AppVersion}-setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=lowest
CloseApplications=yes
RestartApplications=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Additional shortcuts:"; Flags: unchecked

[Dirs]
Name: "{app}\data"
Name: "{app}\novels"

[Files]
Source: "{#ProjectRoot}\target\release\{#AppExeName}"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#ProjectRoot}\frontend\dist\*"; DestDir: "{app}\frontend\dist"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#ProjectRoot}\config.example.toml"; DestDir: "{app}"; DestName: "config.toml"; Flags: ignoreversion onlyifdoesntexist
Source: "{#ProjectRoot}\README.md"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\TXT Reader"; Filename: "{app}\{#AppExeName}"; WorkingDir: "{app}"
Name: "{group}\Uninstall TXT Reader"; Filename: "{uninstallexe}"
Name: "{autodesktop}\TXT Reader"; Filename: "{app}\{#AppExeName}"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#AppExeName}"; Description: "Launch TXT Reader"; WorkingDir: "{app}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
Type: filesandordirs; Name: "{app}\frontend"
