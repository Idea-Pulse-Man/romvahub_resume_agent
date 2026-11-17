' Starts the Romva Resume Agent with no console window (used by the logon task).
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
here = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = here
shell.Run "node """ & here & "\src\agent.js""", 0, False
