const DEFAULT_FREQUENCY_MIN_HZ = 30
const DEFAULT_FREQUENCY_MAX_HZ = 16000
const MIN_FREQUENCY_GAP_HZ = 10
const START_DELAY_SECONDS = 0.2
const END_PADDING_SECONDS = 0.8
const SILENT_LEVELS = 8
const HEADER_PADDING = 10
const LABEL_TEXT_MARGIN = 8

const VIDEO_TYPES = [
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
  'video/mp4'
]

const STOP_MESSAGES = {
  finished: 'Render finished, watch or download it.',
  user: 'Render stopped, the video has what was recorded so far.',
  focus: 'Render stopped because the window lost focus, the video has what was recorded so far.'
}

const $ = id => document.getElementById(id)

const elements = {
  fileInput: $('file-input'),
  trackList: $('track-list'),
  width: $('setting-width'),
  height: $('setting-height'),
  fps: $('setting-fps'),
  scrollStep: $('setting-scroll-step'),
  minHz: $('setting-min-hz'),
  maxHz: $('setting-max-hz'),
  fftSize: $('setting-fft-size'),
  bitrate: $('setting-bitrate'),
  renderButton: $('render-button'),
  stopButton: $('stop-button'),
  status: $('status'),
  app: $('app'),
  progressRing: $('progress-ring'),
  progressPercent: $('progress-percent'),
  progressRemaining: $('progress-remaining'),
  canvas: $('preview-canvas'),
  resultVideo: $('result-video'),
  downloadLink: $('download-link')
}

const canvasContext = elements.canvas.getContext('2d', { alpha: false })
const decodeContext = new AudioContext()

const state = {
  tracks: [],
  stage: 'empty',
  resultUrl: null,
  session: null
}

const pad2 = number => String(number).padStart(2, '0')
const clamp = (value, min, max) => Math.min(max, Math.max(min, value))

const formatClock = totalSeconds => {
  const seconds = Math.floor(totalSeconds)
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const rest = seconds % 60

  if (hours > 0) {
    return `${hours}:${pad2(minutes)}:${pad2(rest)}`
  }

  return `${minutes}:${pad2(rest)}`
}

const formatRemaining = totalSeconds => {
  const seconds = Math.max(0, Math.ceil(totalSeconds))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const rest = seconds % 60

  if (hours > 0) {
    return `${hours}h ${pad2(minutes)}m ${pad2(rest)}s`
  }

  if (minutes > 0) {
    return `${minutes}m ${pad2(rest)}s`
  }

  return `${rest}s`
}

const channelName = (index, total) => {
  if (total === 1) return 'Mono'
  if (total === 2) return index === 0 ? 'Left' : 'Right'
  return `Ch ${index + 1}`
}

const stripExtension = fileName => fileName.replace(/\.[^.]+$/, '')

const compareNames = (a, b) =>
  a.name.localeCompare(b.name, undefined, { numeric: true })

const setStatus = text => {
  elements.status.textContent = text
}

const readSettings = () => ({
  width: Number(elements.width.value),
  height: Number(elements.height.value),
  fps: Number(elements.fps.value),
  scrollStep: Number(elements.scrollStep.value),
  minHz: Number(elements.minHz.value),
  maxHz: Number(elements.maxHz.value),
  fftSize: Number(elements.fftSize.value),
  bitrate: Number(elements.bitrate.value)
})

const getSourceSampleRate = () =>
  Math.min(
    ...state.tracks.map(
      track => track.buffer.sampleRate
    )
  )

const validateFrequencySettings = settings => {
  const sampleRate =
    getSourceSampleRate()

  const nyquist =
    sampleRate / 2

  const resolution =
    sampleRate / settings.fftSize

  let minHz =
    Number.isFinite(settings.minHz)
      ? settings.minHz
      : DEFAULT_FREQUENCY_MIN_HZ

  let maxHz =
    Number.isFinite(settings.maxHz)
      ? settings.maxHz
      : DEFAULT_FREQUENCY_MAX_HZ

  minHz =
    Math.max(
      resolution,
      minHz,
      1
    )

  maxHz =
    clamp(
      maxHz,
      minHz + MIN_FREQUENCY_GAP_HZ,
      nyquist
    )

  if (
    maxHz - minHz <
    MIN_FREQUENCY_GAP_HZ
  ) {
    minHz =
      Math.max(
        resolution,
        nyquist -
        MIN_FREQUENCY_GAP_HZ
      )

    maxHz =
      nyquist
  }

  if (
    maxHz <= minHz ||
    maxHz - minHz <
    MIN_FREQUENCY_GAP_HZ
  ) {
    throw new Error(
      `Invalid frequency range. FFT resolution is ${resolution.toFixed(2)} Hz and Nyquist is ${nyquist.toFixed(2)} Hz.`
    )
  }

  elements.minHz.value =
    String(
      Number(minHz.toFixed(2))
    )

  elements.maxHz.value =
    String(
      Number(maxHz.toFixed(2))
    )

  return {
    ...settings,
    minHz,
    maxHz,
    sampleRate,
    nyquist,
    resolution
  }
}

const readTheme = () => {
  const styles = getComputedStyle(document.documentElement)

  const text = name =>
    styles.getPropertyValue(name).trim()

  const number = name =>
    parseFloat(text(name))

  return {
    font: text('--video-font'),
    background: text('--video-background'),
    headerBackground: text('--video-header-background'),
    labelBackground: text('--video-label-background'),
    textColor: text('--video-text-color'),
    mutedColor: text('--video-muted-color'),
    dividerColor: text('--video-divider-color'),
    headerHeight: number('--video-header-height'),
    headerFontSize: number('--video-header-font-size'),
    labelWidth: number('--video-label-width'),
    labelFontSize: number('--video-label-font-size'),
    hueStart: number('--spectrogram-hue-start'),
    hueEnd: number('--spectrogram-hue-end')
  }
}

const longestDuration = () =>
  Math.max(...state.tracks.map(track => track.buffer.duration))

const totalChannelRows = () =>
  state.tracks.reduce(
    (sum, track) => sum + track.buffer.numberOfChannels,
    0
  )

const buildRowLabels = () =>
  state.tracks.flatMap(track => {
    const channels = track.buffer.numberOfChannels
    const durationText = formatClock(track.buffer.duration)

    return Array.from(
      { length: channels },
      (_, index) =>
        `${track.name} [${channelName(index, channels)}] ${durationText}`
    )
  })

const createElement = (tag, className, text) => {
  const element = document.createElement(tag)

  element.className = className

  if (text) {
    element.textContent = text
  }

  return element
}

const createTrackItem = (track, index) => {
  const item = createElement('li', 'track-item')

  const name = createElement(
    'span',
    'track-name',
    track.name
  )

  const meta = createElement(
    'span',
    'track-meta',
    `${track.buffer.numberOfChannels} ch, ${formatClock(track.buffer.duration)}`
  )

  const removeButton = createElement(
    'button',
    'button',
    'Remove'
  )

  removeButton.addEventListener(
    'click',
    () => removeTrack(index)
  )

  item.append(
    name,
    meta,
    removeButton
  )

  return item
}

const renderTrackList = () => {
  elements.trackList.replaceChildren(
    ...state.tracks.map(createTrackItem)
  )
}

const idleStatusText = () =>
  state.tracks.length
    ? `${totalChannelRows()} channel row(s) ready.`
    : 'Load audio files to start.'

const setStage = stage => {
  state.stage = stage
  document.body.dataset.stage = stage

  const isRendering = stage === 'rendering'

  elements.app.inert = isRendering
  elements.fileInput.disabled = isRendering

  elements.renderButton.disabled =
    isRendering || state.tracks.length === 0

  elements.stopButton.disabled = !isRendering
}

const discardResult = () => {
  if (!state.resultUrl) return

  elements.resultVideo.removeAttribute('src')
  elements.resultVideo.load()

  elements.downloadLink.removeAttribute('href')

  URL.revokeObjectURL(state.resultUrl)

  state.resultUrl = null
}

const onTracksChanged = () => {
  discardResult()

  renderTrackList()

  setStage(
    state.tracks.length
      ? 'ready'
      : 'empty'
  )

  setStatus(idleStatusText())

  if (state.tracks.length) {
    paintPreview()
  }
}

const removeTrack = index => {
  if (state.stage === 'rendering') return

  state.tracks.splice(index, 1)

  onTracksChanged()
}

const addFiles = async fileList => {
  const files = [...fileList].sort(compareNames)

  let failedName = null

  for (const file of files) {
    setStatus(`Decoding ${file.name}...`)

    try {
      const buffer =
        await decodeContext.decodeAudioData(
          await file.arrayBuffer()
        )

      state.tracks.push({
        name: stripExtension(file.name),
        buffer
      })
    } catch (error) {
      failedName = file.name
      break
    }
  }

  onTracksChanged()

  if (failedName) {
    setStatus(`Could not decode ${failedName}`)
  }
}

const computeLayout = (rowCount, settings, theme) => {
  const plotTop = theme.headerHeight

  return {
    width: settings.width,
    height: settings.height,
    rowCount,
    rowHeight: Math.max(
      1,
      Math.floor(
        (settings.height - plotTop) / rowCount
      )
    ),
    plotTop,
    plotLeft: theme.labelWidth,
    plotWidth: settings.width - theme.labelWidth,
    plotHeight: settings.height - plotTop
  }
}

const buildScene = () => {
  const settings = readSettings()
  const theme = readTheme()
  const rowLabels = buildRowLabels()

  const layout = computeLayout(
    rowLabels.length,
    settings,
    theme
  )

  elements.canvas.width = settings.width
  elements.canvas.height = settings.height

  return {
    settings,
    theme,
    layout,
    rowLabels
  }
}

const fillBox = (
  color,
  x,
  y,
  width,
  height
) => {
  canvasContext.fillStyle = color
  canvasContext.fillRect(
    x,
    y,
    width,
    height
  )
}

const describeSpectrogram = settings =>
  `${settings.width}x${settings.height}, ${settings.fps} FPS, ${settings.bitrate} Mbps, FFT ${settings.fftSize}, log ${settings.minHz} Hz to ${settings.maxHz} Hz, ${settings.scrollStep} px/frame`

const drawHeader = (
  scene,
  elapsedSeconds
) => {
  const {
    theme,
    layout,
    settings
  } = scene

  const middle =
    theme.headerHeight / 2

  fillBox(
    theme.headerBackground,
    0,
    0,
    layout.width,
    theme.headerHeight
  )

  canvasContext.font =
    `${theme.headerFontSize}px ${theme.font}`

  canvasContext.textBaseline = 'middle'

  canvasContext.textAlign = 'left'
  canvasContext.fillStyle = theme.textColor

  canvasContext.fillText(
    `${formatClock(elapsedSeconds)} / ${formatClock(longestDuration())}`,
    HEADER_PADDING,
    middle
  )

  canvasContext.textAlign = 'right'
  canvasContext.fillStyle = theme.mutedColor

  canvasContext.fillText(
    describeSpectrogram(settings),
    layout.width - HEADER_PADDING,
    middle,
    layout.width * 0.7
  )
}

const drawVerticalText = (
  text,
  centerX,
  centerY,
  maxLength,
  color
) => {
  canvasContext.save()

  canvasContext.translate(
    centerX,
    centerY
  )

  canvasContext.rotate(-Math.PI / 2)

  canvasContext.fillStyle = color

  canvasContext.fillText(
    text,
    0,
    0,
    maxLength
  )

  canvasContext.restore()
}

const drawRowLabels = scene => {
  const {
    theme,
    layout,
    rowLabels
  } = scene

  canvasContext.font =
    `${theme.labelFontSize}px ${theme.font}`

  canvasContext.textBaseline = 'middle'
  canvasContext.textAlign = 'center'

  rowLabels.forEach((label, index) => {
    const top =
      layout.plotTop +
      index * layout.rowHeight

    fillBox(
      theme.labelBackground,
      0,
      top,
      layout.plotLeft,
      layout.rowHeight
    )

    drawVerticalText(
      label,
      layout.plotLeft / 2,
      top + layout.rowHeight / 2,
      layout.rowHeight - LABEL_TEXT_MARGIN,
      theme.textColor
    )

    fillBox(
      theme.dividerColor,
      0,
      top + layout.rowHeight - 1,
      layout.width,
      1
    )
  })
}

const paintStillFrame = scene => {
  fillBox(
    scene.theme.background,
    0,
    0,
    scene.layout.width,
    scene.layout.height
  )

  drawHeader(scene, 0)
  drawRowLabels(scene)
}

const paintPreview = () =>
  paintStillFrame(buildScene())

const buildPalette = theme =>
  Array.from(
    { length: 256 },
    (_, level) => {
      if (level < SILENT_LEVELS) {
        return '#000'
      }

      const ratio = level / 255

      const hue =
        theme.hueStart +
        (theme.hueEnd - theme.hueStart) *
        ratio

      const lightness =
        Math.min(
          60,
          ratio * 90
        )

      return `hsl(${hue} 100% ${lightness}%)`
    }
  )

const buildFrequencyMap = (
  rowHeight,
  sampleRate,
  binCount,
  minHz,
  maxHz
) => {
  const nyquist =
    sampleRate / 2

  const safeMinHz =
    Math.max(
      minHz,
      sampleRate / (binCount * 2)
    )

  const safeMaxHz =
    Math.min(
      maxHz,
      nyquist
    )

  const logRange =
    Math.log(
      safeMaxHz / safeMinHz
    )

  return Int32Array.from(
    { length: rowHeight },
    (_, y) => {
      const position =
        rowHeight <= 1
          ? 1
          : 1 -
          y /
          (rowHeight - 1)

      const hz =
        safeMinHz *
        Math.exp(
          position *
          logRange
        )

      return Math.min(
        binCount - 1,
        Math.max(
          0,
          Math.round(
            (hz / nyquist) *
            binCount
          )
        )
      )
    }
  )
}

const scrollPlotLeft = scene => {
  const {
    layout,
    settings
  } = scene

  const step =
    Math.min(
      settings.scrollStep,
      layout.plotWidth
    )

  if (step < 1) return

  canvasContext.drawImage(
    elements.canvas,
    layout.plotLeft + step,
    layout.plotTop,
    layout.plotWidth - step,
    layout.plotHeight,
    layout.plotLeft,
    layout.plotTop,
    layout.plotWidth - step,
    layout.plotHeight
  )
}

const drawNewColumn = (
  scene,
  palette,
  readers,
  frequencyMap
) => {
  const {
    layout,
    settings,
    theme
  } = scene

  const step =
    Math.min(
      settings.scrollStep,
      layout.plotWidth
    )

  const x =
    layout.width - step

  readers.forEach(
    (reader, rowIndex) => {
      reader.analyser.getByteFrequencyData(
        reader.data
      )

      const top =
        layout.plotTop +
        rowIndex *
        layout.rowHeight

      for (
        let y = 0;
        y < layout.rowHeight - 1;
        y++
      ) {
        canvasContext.fillStyle =
          palette[
          reader.data[
          frequencyMap[y]
          ]
          ]

        canvasContext.fillRect(
          x,
          top + y,
          step,
          1
        )
      }

      fillBox(
        theme.dividerColor,
        x,
        top + layout.rowHeight - 1,
        step,
        1
      )
    }
  )
}

const createAnalyser = (
  audioContext,
  fftSize
) => {
  const analyser =
    audioContext.createAnalyser()

  analyser.fftSize = fftSize
  analyser.smoothingTimeConstant = 0
  analyser.minDecibels = -90
  analyser.maxDecibels = -10

  return analyser
}

const buildAudioGraph = (
  audioContext,
  fftSize
) => {
  const analysers = []

  const recordingDestination =
    audioContext.createMediaStreamDestination()

  const sources =
    state.tracks.map(track => {
      const channels =
        track.buffer.numberOfChannels

      const source =
        audioContext.createBufferSource()

      source.buffer = track.buffer

      const splitter =
        audioContext.createChannelSplitter(
          channels
        )

      source.connect(splitter)

      for (
        let channel = 0;
        channel < channels;
        channel++
      ) {
        const analyser =
          createAnalyser(
            audioContext,
            fftSize
          )

        splitter.connect(
          analyser,
          channel
        )

        analysers.push(analyser)
      }

      source.connect(
        recordingDestination
      )

      return source
    })

  return {
    sources,
    analysers,
    recordingDestination
  }
}

const pickVideoType = () =>
  VIDEO_TYPES.find(
    type =>
      MediaRecorder.isTypeSupported(type)
  ) || ''

const createRecorder = (
  settings,
  audioStream
) => {
  const videoStream =
    elements.canvas.captureStream(
      settings.fps
    )

  const stream =
    new MediaStream([
      ...videoStream.getVideoTracks(),
      ...audioStream.getAudioTracks()
    ])

  const mimeType =
    pickVideoType()

  const options = {
    videoBitsPerSecond:
      settings.bitrate * 1e6
  }

  if (mimeType) {
    options.mimeType = mimeType
  }

  const recorder =
    new MediaRecorder(
      stream,
      options
    )

  const chunks = []

  recorder.ondataavailable = event => {
    if (event.data.size) {
      chunks.push(event.data)
    }
  }

  return {
    recorder,
    chunks,
    stream
  }
}

const reportProgress = (
  elapsed,
  duration
) => {
  const ratio =
    duration > 0
      ? clamp(
        elapsed / duration,
        0,
        1
      )
      : 1

  elements.progressRing.style.setProperty(
    '--progress',
    ratio
  )

  elements.progressPercent.textContent =
    `${Math.floor(ratio * 100)}%`

  elements.progressRemaining.textContent =
    ratio >= 1
      ? 'Finishing render...'
      : `${formatRemaining(
        duration - elapsed
      )} remaining`
}

const makeSeekable = video => {
  if (video.duration !== Infinity) {
    return
  }

  video.currentTime = 1e101

  video.addEventListener(
    'timeupdate',
    () => {
      video.currentTime = 0
    },
    { once: true }
  )
}

const loadPlayer = url => {
  const video =
    elements.resultVideo

  video.addEventListener(
    'loadedmetadata',
    () => makeSeekable(video),
    { once: true }
  )

  video.src = url
}

const finishRender = session => {
  session.audioContext.close()

  if (session.stream) {
    session.stream
      .getTracks()
      .forEach(track => track.stop())
  }

  state.session = null

  const type =
    session.recorder.mimeType ||
    'video/webm'

  const blob =
    new Blob(
      session.chunks,
      { type }
    )

  if (!blob.size) {
    setStage('ready')

    setStatus(
      'The recording came out empty. Try again or use another browser.'
    )

    return
  }

  const extension =
    type.includes('mp4')
      ? 'mp4'
      : 'webm'

  state.resultUrl =
    URL.createObjectURL(blob)

  loadPlayer(
    state.resultUrl
  )

  elements.downloadLink.href =
    state.resultUrl

  elements.downloadLink.download =
    `spectrogram.${extension}`

  elements.downloadLink.textContent =
    `Download video (${extension})`

  setStage('done')

  setStatus(
    STOP_MESSAGES[
    session.stopReason
    ] || STOP_MESSAGES.user
  )
}

const stopRender = reason => {
  const session =
    state.session

  if (
    !session ||
    session.isStopping
  ) {
    return
  }

  session.isStopping = true
  session.stopReason = reason

  clearTimeout(
    session.endTimer
  )

  cancelAnimationFrame(
    session.frameRequest
  )

  session.sources.forEach(
    source => {
      try {
        source.stop()
      } catch (error) { }
    }
  )

  if (
    session.recorder.state !==
    'inactive'
  ) {
    session.recorder.stop()
  } else {
    finishRender(session)
  }
}

const startRender = async () => {
  discardResult()

  const scene =
    buildScene()

  scene.settings =
    validateFrequencySettings(
      scene.settings
    )

  const duration =
    longestDuration()

  if (
    !duration ||
    !state.tracks.length
  ) {
    return
  }

  const audioContext =
    new AudioContext()

  await audioContext.resume()

  const graph =
    buildAudioGraph(
      audioContext,
      scene.settings.fftSize
    )

  const {
    recorder,
    chunks,
    stream
  } =
    createRecorder(
      scene.settings,
      graph.recordingDestination.stream
    )

  const palette =
    buildPalette(
      scene.theme
    )

  const readers =
    graph.analysers.map(
      analyser => ({
        analyser,
        data:
          new Uint8Array(
            analyser.frequencyBinCount
          )
      })
    )

  const frequencyMap =
    buildFrequencyMap(
      scene.layout.rowHeight,
      audioContext.sampleRate,
      graph.analysers[0]
        .frequencyBinCount,
      scene.settings.minHz,
      scene.settings.maxHz
    )

  const session = {
    audioContext,
    sources: graph.sources,
    recorder,
    chunks,
    stream,
    frameRequest: 0,
    endTimer: 0,
    isStopping: false,
    stopReason: 'finished'
  }

  state.session = session

  recorder.onstop = () =>
    finishRender(session)

  paintStillFrame(scene)

  reportProgress(
    0,
    duration
  )

  setStatus('Rendering...')
  setStage('rendering')

  elements.stopButton.focus()

  const startTime =
    audioContext.currentTime +
    START_DELAY_SECONDS

  graph.sources.forEach(
    source =>
      source.start(startTime)
  )

  recorder.start(1000)

  const drawFrame = () => {
    if (session.isStopping) {
      return
    }

    const elapsed =
      clamp(
        audioContext.currentTime -
        startTime,
        0,
        duration
      )

    scrollPlotLeft(scene)

    drawNewColumn(
      scene,
      palette,
      readers,
      frequencyMap
    )

    drawHeader(
      scene,
      elapsed
    )

    reportProgress(
      elapsed,
      duration
    )

    session.frameRequest =
      requestAnimationFrame(
        drawFrame
      )
  }

  session.frameRequest =
    requestAnimationFrame(
      drawFrame
    )

  session.endTimer =
    setTimeout(
      () =>
        stopRender('finished'),
      (duration +
        END_PADDING_SECONDS) *
      1000
    )
}

const onSettingChanged = () => {
  if (!state.tracks.length) {
    return
  }

  try {
    const settings =
      validateFrequencySettings(
        readSettings()
      )

    setStatus(
      `Sample rate: ${settings.sampleRate} Hz · Nyquist: ${settings.nyquist} Hz · FFT resolution: ${settings.resolution.toFixed(2)} Hz`
    )

    if (state.stage === 'ready') {
      paintPreview()
    }
  } catch (error) {
    setStatus(
      `Error: ${error.message}`
    )
  }
}

elements.fileInput.addEventListener(
  'change',
  async event => {
    await addFiles(
      event.target.files
    )

    event.target.value = ''
  }
)

elements.renderButton.addEventListener(
  'click',
  () => {
    startRender().catch(
      error => {
        if (state.session) {
          state.session.stopReason =
            'user'

          stopRender('user')
        }

        setStage('ready')

        setStatus(
          `Error: ${error.message}`
        )
      }
    )
  }
)

elements.stopButton.addEventListener(
  'click',
  () =>
    stopRender('user')
)

window.addEventListener(
  'blur',
  () =>
    stopRender('focus')
)

document.addEventListener(
  'visibilitychange',
  () => {
    if (document.hidden) {
      stopRender('focus')
    }
  }
)

  ;[
    elements.width,
    elements.height,
    elements.fftSize,
    elements.scrollStep,
    elements.minHz,
    elements.maxHz
  ].forEach(input => {
    input.addEventListener(
      'change',
      onSettingChanged
    )
  })

setStage('empty')
setStatus(idleStatusText())