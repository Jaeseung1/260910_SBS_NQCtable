' Starts windows\tray.ps1 (the NQC schedule server tray launcher) without a console window.
' Used by the Startup-folder and desktop shortcuts that windows\install.cmd creates.
' Extra arguments (for example -Show) are passed on to tray.ps1.
' Keep this file ASCII only: wscript reads it in the system code page.
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
extra = ""
For Each a In WScript.Arguments
  extra = extra & " " & a
Next
cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -STA -File """ & here & "\tray.ps1""" & extra
CreateObject("WScript.Shell").Run cmd, 0, False
