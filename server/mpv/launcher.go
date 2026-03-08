package mpv

import (
	"os/exec"
)

type ExecLauncher struct{}

func (el *ExecLauncher) Launch(url string) (Process, error) {
	args := mpvArgs(url)
	cmd := exec.Command("mpv", args...)

	if err := cmd.Start(); err != nil {
		return nil, err
	}

	return cmd.Process, nil
}

func mpvArgs(url string) []string {
	return []string{
		"--fullscreen",
		"--input-ipc-server=" + SOCKET_PATH,
		"--ytdl",
		"--volume=80",

		// HARDWARE ACCELERATION (RPi5)
		"--hwdec=auto-safe",

		// CACHING - pause if buffer runs low instead of slow-mo
		"--cache=yes",
		"--cache-secs=60",
		"--cache-pause=yes",
		"--cache-pause-wait=5",
		"--demuxer-max-bytes=300MiB",
		"--demuxer-max-back-bytes=150MiB",
		"--demuxer-readahead-secs=60",

		// PERFORMANCE
		"--framedrop=vo",

		// AUDIO
		"--audio-buffer=1",

		// NETWORK
		"--network-timeout=30",
		"--force-seekable=yes",

		// YOUTUBE: Prefer H.264 (hardware decoded) over VP9/AV1
		"--ytdl-format=bestvideo[height<=1080][vcodec^=avc1]+bestaudio[acodec^=mp4a]/bestvideo[height<=1080][vcodec^=avc1]+bestaudio/best[height<=1080]",

		url,
	}
}
