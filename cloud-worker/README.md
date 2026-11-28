---
title: STEM Free Cloud Worker
emoji: 🎚️
colorFrom: green
colorTo: blue
sdk: gradio
sdk_version: 5.32.0
python_version: 3.11
app_file: app.py
pinned: false
---

# STEM Free Cloud Worker

Optional cloud fallback for the STEM Audio Workbench. Uses open-source Demucs on Hugging Face ZeroGPU when capacity is available.

Free ZeroGPU access has usage quotas, eligibility restrictions, queueing and availability limits. This is not an unlimited service. The STEM local processor is the primary free option.

The app exposes a Gradio API named separate with inputs: audio file and output format (wav or mp3), and returns a ZIP archive of the six stems.
