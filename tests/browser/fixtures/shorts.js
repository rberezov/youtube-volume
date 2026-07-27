module.exports = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  body { margin: 0; background: #0f0f0f; }
  #shorts-container { display: flex; justify-content: center; padding: 16px; }
  .short-video-container { position: relative; width: 420px; height: 740px; }
  .player-wrapper, #player-container, ytd-player, #container { display: block; height: 100%; }
  .html5-video-player { position: relative; width: 100%; height: 100%; background: #333; }
  video { width: 100%; height: 100%; background: #6b4a2f; display: block; }
  /* классическая обвязка плеера: полоса перемотки поверх строки кнопок */
  .ytp-chrome-bottom { position: absolute; left: 12px; right: 12px; bottom: 12px; }
  .ytp-chrome-controls { display: flex; align-items: center; height: 44px; }
  .ytp-left-controls { display: flex; align-items: center; flex: 1 1 auto; min-width: 0; }
  .ytp-progress-bar-container { position: absolute; left: 60px; right: 20px; top: 20px; height: 4px; }
  .ytp-progress-bar { height: 100%; background: #fff; }
  /* строка кнопок Shorts — поверх видео сверху слева */
  .player-controls { position: absolute; top: 12px; left: 12px; z-index: 10; }
  ytd-shorts-player-controls, #left-controls { display: flex; align-items: center; gap: 8px; }
  #play-pause-button-shape button { width: 48px; height: 48px; border-radius: 50%;
    border: none; background: rgba(0,0,0,.6); color: #fff; }
  volume-controls { display: block; }
  .ytdVolumeControlsVolumeControlsContainer { position: relative; display: flex;
    align-items: center; height: 48px; width: 60px; }
  .ytdVolumeControlsBackgroundScrim { position: absolute; inset: 0;
    background: rgba(0,0,0,.6); border-radius: 24px; }
  .ytdVolumeControlsMuteIconButton { position: relative; width: 48px; height: 48px;
    border: none; background: none; color: #fff; }
</style></head><body>
<ytd-shorts>
  <div id="shorts-container">
    <div id="shorts-inner-container">
      <div id="reel-overlay-container">
        <ytd-reel-video-renderer id="reel-video-renderer">
          <div class="short-video-container" id="short-video-container">
            <div class="player-wrapper">
              <div id="player-container" class="player-container">
                <ytd-player id="player"><div id="container"><div class="html5-video-player">
                  <video></video>
                  <div class="ytp-chrome-bottom">
                    <div class="ytp-chrome-controls">
                      <div class="ytp-left-controls">
                        <button class="ytp-play-button">P</button>
                        <div class="ytp-volume-area">
                          <button class="ytp-mute-button">V</button>
                          <div class="ytp-volume-panel"></div>
                        </div>
                      </div>
                    </div>
                    <div class="ytp-progress-bar-container"><div class="ytp-progress-bar"></div></div>
                  </div>
                </div></div></ytd-player>
              </div>
              <div class="player-controls">
                <ytd-shorts-player-controls>
                  <div id="left-controls">
                    <yt-button-shape id="play-pause-button-shape"><button>▶</button></yt-button-shape>
                    <volume-controls class="ytdVolumeControlsHost style-scope ytd-shorts-player-controls">
                      <div class="ytdVolumeControlsVolumeControlsContainer">
                        <div class="ytdVolumeControlsBackgroundScrim"></div>
                        <div>
                          <button class="ytdVolumeControlsMuteIconButton" aria-label="Mute" title="Mute">
                            <span class="ytIconWrapperHost ytdVolumeControlsMuteIcon" role="img">S</span>
                          </button>
                        </div>
                        <div class="ytdVolumeControlsSliderContainer"></div>
                      </div>
                    </volume-controls>
                  </div>
                  <div id="right-controls">
                    <yt-button-shape id="menu-button"><button>⋯</button></yt-button-shape>
                  </div>
                </ytd-shorts-player-controls>
              </div>
            </div>
          </div>
        </ytd-reel-video-renderer>
      </div>
    </div>
  </div>
</ytd-shorts>
<script>
  const p = document.querySelector('.html5-video-player');
  p.setVolume = (v) => { p._v = v; };
  p.mute = () => { p.querySelector('video').muted = true; };
  p.unMute = () => { p.querySelector('video').muted = false; };
</script></body></html>`;