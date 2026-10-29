@echo off
rem Open the local console (credentials / connect / allow peers are all in that page).
rem Double-click this file. If node is not on PATH, fall back to the runtime shipped with DSH.
chcp 65001 >nul
setlocal
set "ROOT=%~dp0.."
set "NODE_EXE="
for %%I in (node.exe) do if not "%%~$PATH:I"=="" set "NODE_EXE=%%~$PATH:I"
if not defined NODE_EXE if exist "%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" (
  set "NODE_EXE=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
)
if not defined NODE_EXE (
  echo [x] node.exe not found, and no bundled DSH runtime either.
  pause
  exit /b 1
)
"%NODE_EXE%" "%ROOT%\bin\cli.mjs" ui %*
if errorlevel 1 pause
endlocal
