' 无窗口启动桌宠：双击桌面快捷方式后不弹 cmd 黑框
Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "d:\code\deepseek-desktop-pet"
WshShell.Run "npm start", 0, False
