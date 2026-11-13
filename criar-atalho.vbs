' Cria o atalho "PokeIdle Farm" na Area de Trabalho e no Menu Iniciar.
' O app abre direto, sem terminal, com o icone da pokebola.
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
exe = dir & "\node_modules\electron\dist\electron.exe"

If Not fso.FileExists(exe) Then
  MsgBox "Rode o iniciar.bat uma vez antes (ele instala as dependencias).", 48, "PokeIdle Farm"
  WScript.Quit
End If

For Each loc In Array(sh.SpecialFolders("Desktop"), sh.SpecialFolders("Programs"))
  Set lnk = sh.CreateShortcut(loc & "\PokeIdle Farm.lnk")
  lnk.TargetPath = exe
  lnk.Arguments = """" & dir & """"
  lnk.WorkingDirectory = dir
  lnk.IconLocation = dir & "\assets\icon.ico, 0"
  lnk.Description = "PokeIdle Farm"
  lnk.Save
Next

MsgBox "Pronto! Use o atalho PokeIdle Farm na Area de Trabalho ou no Menu Iniciar.", 64, "PokeIdle Farm"
