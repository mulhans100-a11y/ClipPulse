#!/usr/bin/env bash
set -euo pipefail

ubuntu_sources='/etc/apt/sources.list.d/ubuntu.sources'
if [[ -f "$ubuntu_sources" ]]; then
  sudo sed -i 's|azure.archive.ubuntu.com|archive.ubuntu.com|g' "$ubuntu_sources"
fi

# Current Ubuntu hosted runners route their Ubuntu sources through this mirror
# list instead of naming azure.archive.ubuntu.com in ubuntu.sources directly.
# Update that indirection too, otherwise the replacement above has no effect
# and the FFmpeg dependency download can stall on the Azure mirror.
ubuntu_mirrors='/etc/apt/apt-mirrors.txt'
if [[ -f "$ubuntu_mirrors" ]]; then
  sudo sed -i 's|azure.archive.ubuntu.com|archive.ubuntu.com|g' "$ubuntu_mirrors"
fi

apt_options=(-o Acquire::Retries=3 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30)
sudo apt-get "${apt_options[@]}" update
sudo apt-get "${apt_options[@]}" install --yes ffmpeg
