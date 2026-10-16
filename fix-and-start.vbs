Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

' 清理 Electron 缓存（防止损坏导致启动失败）
Dim cacheDirs, dir
cacheDirs = Array("Cache", "Code Cache", "DawnGraphiteCache", "DawnWebGPUCache", "GPUCache")

For Each dir In cacheDirs
    Dim fullPath
    fullPath = "D:\DeepSeekPet\" & dir
    If fso.FolderExists(fullPath) Then
        On Error Resume Next
        fso.DeleteFolder fullPath, True
        On Error GoTo 0
    End If
Next

' 启动桌宠
shell.CurrentDirectory = "D:\code\deepseek-desktop-pet"
shell.Run "D:\code\deepseek-desktop-pet\node_modules\electron\dist\electron.exe D:\code\deepseek-desktop-pet", 0, False

Set shell = Nothing
Set fso = Nothing
