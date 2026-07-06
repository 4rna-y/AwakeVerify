# Worker GUI local validation

`src/worker/gui` is an OpenCV GUI app for validating Worker face tracking, calibration, and drowsiness scoring with a local webcam. It uses `src/worker/shared` and does not connect to Service Bus, Blob Storage, PostgreSQL, Redis, or SignalR.

## Feature / scenario scope

This app supports local validation for:

- `docs/features/06-face-recognition.md`
- `docs/features/07-calibration.md`
- `docs/features/08-drowsiness-scoring.md`
- `docs/features/10-auto-pause-resume.md`
- `docs/scenarios/student-learning-happy-path.md`
- `docs/scenarios/calibration-retry.md`
- `docs/scenarios/face-not-detected-warning.md`
- `docs/scenarios/drowsiness-auto-pause-resume.md`

## Model file

MediaPipe Face Landmarker requires a `.task` model file.

```bash
mkdir -p /workspace/src/worker/models
curl -L -o /workspace/src/worker/models/face_landmarker.task \
  https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task
```

## Linux host display from devcontainer

The devcontainer mounts the X11 socket and forwards `DISPLAY` to the container. On the Linux host, allow local Docker containers to connect to X11 before starting or rebuilding the devcontainer:

```bash
xhost +local:docker
```

Then rebuild/reopen the devcontainer. Inside the container, confirm:

```bash
echo $DISPLAY
xclock
```

If `DISPLAY` is empty, set it in `.devcontainer/.env`, for example:

```dotenv
DISPLAY=:0
```

When finished, you can revoke the broad local Docker X11 permission on the host:

```bash
xhost -local:docker
```

## Webcam access from devcontainer

Docker must be allowed to access the host camera device. The devcontainer maps host `/dev/video0` to container `/dev/video0` by default.

First, check the camera device on the host OS, outside the devcontainer:

```bash
v4l2-ctl --list-devices
ls -l /dev/video*
```

If your host camera is not `/dev/video0`, edit `.devcontainer/docker-compose.yml` and change the `devices` mapping under the `devcontainer` service.

If the device is visible but OpenCV cannot open it, check the device group ID. For example, `crw-rw---- 1 root 985 ... /dev/video0` means the container user must belong to supplemental group `985`; being in the container's `video` group is not enough if that group has a different numeric ID.

Set the host camera group ID for Docker Compose, then rebuild/reopen the devcontainer:

```bash
HOST_VIDEO_GID=$(stat -c '%g' /dev/video0)
echo "HOST_VIDEO_GID=${HOST_VIDEO_GID}" >> .devcontainer/.env
```

Then rebuild/reopen the devcontainer. Inside the container, confirm that the device is visible and accessible:

```bash
id
ls -l /dev/video*
v4l2-ctl --device /dev/video0 --all
```

Run the GUI with the matching camera index. For `/dev/video0`, use the default `--camera 0`; for `/dev/video2`, use `--camera 2`.

## Native library requirements

MediaPipe loads native shared libraries at runtime. The devcontainer installs the required OpenGL/EGL/Mesa libraries, including `libGLESv2.so.2`, and sets `LIBGL_ALWAYS_SOFTWARE=1` because the default devcontainer does not pass through a host GPU/DRI device.

MediaPipe may print startup warnings before the GUI opens, for example:

```text
WARNING: All log messages before absl::InitializeLog() is called are written to STDERR
W0000 ... Sets FaceBlendshapesGraph acceleration to xnnpack by default.
```

These are informational and can be ignored if the GUI continues to run.

If `worker-gui` fails with an error like the following, rebuild the devcontainer after updating `.devcontainer/Dockerfile`:

```text
OSError: libGLESv2.so.2: cannot open shared object file: No such file or directory
```

For a temporary fix in the current container, install the missing libraries manually:

```bash
sudo apt-get update
sudo apt-get install -y --no-install-recommends libgles2 libegl1 libgl1-mesa-dri
export LIBGL_ALWAYS_SOFTWARE=1
```

## Run

From inside the devcontainer, install the Worker package into the virtual environment in editable mode:

```bash
cd /workspace/src/worker
python -m venv .venv
source .venv/bin/activate
pip install -e .
```

Then run the GUI with the console script:

```bash
worker-gui
```

Module execution from the Worker package root is also supported:

```bash
cd /workspace/src/worker
source .venv/bin/activate
python -m gui
```

After `pip install -e .`, direct script execution from `src/worker/gui` can also resolve `shared`:

```bash
cd /workspace/src/worker/gui
source ../.venv/bin/activate
python main.py
```

Useful options:

```bash
worker-gui --camera 0 --analysis-fps 5 --model /workspace/src/worker/models/face_landmarker.task
python -m gui --camera 0 --analysis-fps 5 --model /workspace/src/worker/models/face_landmarker.task
python main.py --camera 0 --analysis-fps 5 --model /workspace/src/worker/models/face_landmarker.task
```

Controls:

| Key | Action |
| --- | --- |
| `q` | Quit |
| `c` | Start/reset calibration |
| `r` | Reset drowsiness score state |
| `space` | Pause/resume camera processing |
