#!/usr/bin/env bash
set -euo pipefail

ubuntu_sources='/etc/apt/sources.list.d/ubuntu.sources'
if [[ -f "$ubuntu_sources" ]]; then
  sudo sed -i 's|azure.archive.ubuntu.com|archive.ubuntu.com|g' "$ubuntu_sources"
fi

apt_options=(-o Acquire::Retries=3 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30)
sudo apt-get "${apt_options[@]}" update
sudo apt-get "${apt_options[@]}" install --yes ffmpeg
