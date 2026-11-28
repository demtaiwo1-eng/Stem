# STEM Local Processor for Windows

1. Download the STEM repository ZIP and extract it.
2. Open this folder.
3. Double-click Start-STEM-Processor.bat.
4. Allow the first-time setup to install Python packages and the Demucs model dependencies. The first setup is a large download and needs several GB of free disk space.
5. Keep the terminal window open while using the STEM website.
6. Refresh https://demtaiwo1-eng.github.io/stem.github.io/; the website should report that the local processor is connected.

The processor listens only on 127.0.0.1:8765. Browser access is restricted to the official STEM GitHub Pages origin by default. Audio is processed on this computer. Only the resulting stem files are uploaded to STEM's private storage to preserve job history and enable previews/downloads.

CPU is the default and works without a GPU, but can be slow. Do not close the processor window until separation is complete.

To stop the processor, press Ctrl+C in its terminal window.