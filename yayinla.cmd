@echo off
rem Uygulamayi GitHub'a gonderir (GitHub Pages adresi kendiliginden guncellenir).
set "PATH=F:\Sofor-Bey\.calisma\git\cmd;%PATH%"
set "TEMP=F:\Sofor-Bey\.calisma"
set "TMP=F:\Sofor-Bey\.calisma"
cd /d "%~dp0"
set "GCM_GUI_PROMPT=false"
git -c credential.helper= -c credential.helper=manager -c credential.gitHubAuthModes=device push -u origin main
if errorlevel 1 (echo HATA: gonderilemedi.) else (echo TAMAM: GitHub'a gonderildi.)
