@echo off
rem asd verify entry: MSVC env + cargo check (vswhom-sys needs INCLUDE/LIB)
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat" >nul 2>&1
cd /d "%~dp0"
cargo check %*
