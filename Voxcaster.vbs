' Double-click to start Voxcaster without a console window.
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
CreateObject("WScript.Shell").Run """" & dir & "\node_modules\electron\dist\electron.exe"" """ & dir & """", 0, False
