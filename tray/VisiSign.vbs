' VisiSign.vbs — double-click to start VisiSign with a system-tray icon and NO
' console window. It launches the tray script hidden. Keep this file next to
' VisiSign.exe and VisiSign-Tray.ps1.
Option Explicit
Dim sh, scriptDir
Set sh = CreateObject("WScript.Shell")
scriptDir = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\"))
sh.CurrentDirectory = scriptDir
' Window style 0 = hidden. The only visible UI is the tray icon.
sh.Run "powershell -NoProfile -ExecutionPolicy Bypass -Sta -WindowStyle Hidden -File """ & scriptDir & "VisiSign-Tray.ps1""", 0, False
