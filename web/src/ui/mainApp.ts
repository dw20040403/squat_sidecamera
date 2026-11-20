// 主端末：カメラA・統合演算・表示・記録・警告
import { VideoRecorder } from '../capture/recorder';
import type { AppConfig } from '../configLoader';
import type { Camera } from '../fusion/camera';
import { cameraCenter } from '../fusion/camera';
import { DltFuser, type FusedFrame, type Fuser } from '../fusion/fuser';
import { fromFlat, JOINT_INDICES, requiredVisible, type Pose2D } from '../fusion/landmarks';
import { fuseFrame, FusionScheduler } from '../fusion/pipeline';
import { NullFeedbackEngine, Speaker, type FeedbackEngine } from '../feedback';
import { cameraAzimuthInBody, type Angles } from '../metrics/angles';
import { Alarm } from '../monitor/alarm';
import { ABORT_MESSAGES, AnomalyMonitor } from '../monitor/anomaly';
import { MovingAverage, RateMeter } from '../monitor/fps';
import { respondSync, type SyncReq } from '../net/clockSync';
import type { CtrlMsg, ExtrinsicsMsg, PoseMsg } from '../net/messages';
import { PeerLink, type PeerState } from '../net/peer';
import { SessionWriter, storageStatus } from '../record/store';
import { sessionIdFromTime, toRecordFrame, type AbortInfo, type Session } from '../record/session';
import { View3D } from '../render/view3d';
import { nowMs } from '../util/clock';
import { downloadBlob, downloadJson, videoExt } from '../util/download';
import { KEYS, loadJson } from '../util/storage';
import { openCalibCapture } from './calibCapture';
import { openCalibCheck } from './calibCheck';
import {
  loadCalibration,
  loadLayoutSelection,
  saveCalibration,
  saveLayoutSelection,
  type CalibrationFile,
  type LayoutSelection,
  type RecordingMeta,
  type StoredCalibration,
} from './calibState';
import { DeviceCore, modeButtons, type DisplayMode } from './device';
import { alertDialog, fmtNum, h, openSheet, toast } from './dom';
import { openExtrinsicsScreen } from './extrinsicsUi';
import { openLayoutScreen } from './layoutScreen';
import type { MainContext, SubInfo } from './mainContext';
import { MetricsPanel } from './metricsPanel';
import { openSessions } from './sessionsScreen';
import { loadSubject, openSettings } from './settings';

export class MainApp implements MainContext {
  readonly core: DeviceCore;
  readonly peer = new PeerLink('main');
  sub: SubInfo = { deviceName: null, intr: null, videoSize: null, status: null, lastPose: null };
  calib: StoredCalibration | null = loadCalibration();
  layoutSel: LayoutSelection;
  private scheduler: FusionScheduler;
  private fuser: Fuser | null = null;
  private fusedListeners = new Set<(f: FusedFrame) => void>();
  private lastFused: FusedFrame | null = null;
  private lastAngles: Angles | null = null;
  private subRate = new RateMeter(2000);
  private fusedRate = new RateMeter(2000);
  private latency = new MovingAverage(20);
  private lastSubPoseAt: number | null = null;
  private bytesPrev = { bytes: 0, t: 0, rate: 0 };
  private view3d: View3D | null = null;
  private panel = new MetricsPanel();
  private monitor: AnomalyMonitor;
  private alarm: Alarm;
  readonly speaker = new Speaker();
  readonly feedback: FeedbackEngine = new NullFeedbackEngine();
  private writer: SessionWriter | null = null;
  private recorder = new VideoRecorder();
  private testRecorder = new VideoRecorder();
  private measuring = false;
  private pendingExtr: ((m: ExtrinsicsMsg) => void) | null = null;
  // UI
  private el: {
    status: HTMLElement;
    start: HTMLButtonElement;
    testRec: HTMLButtonElement;
    reason: HTMLElement;
    devinfo: HTMLElement;
  };

  constructor(
    readonly cfg: AppConfig,
    root: HTMLElement,
  ) {
    this.core = new DeviceCore(cfg, 'main');
    this.layoutSel = loadLayoutSelection(cfg.layout);
    this.scheduler = new FusionScheduler(cfg.params.fusion);
    this.monitor = new AnomalyMonitor(cfg.params.monitor);
    this.alarm = new Alarm(cfg.params.alarm);

    const view3dEl = h('div', { class: 'view3d' });
    const presets = h(
      'div',
      { class: 'presets' },
      ...(['front', 'side', 'top', 'reset'] as const).map((p) =>
        h(
          'button',
          { onclick: () => this.view3d?.preset(p) },
          { front: '正面', side: '側面', top: '上', reset: 'リセット' }[p],
        ),
      ),
    );
    const devinfo = h('div', { class: 'devinfo' }, '');
    const origSetMode = this.core.setMode.bind(this.core);
    this.core.setMode = (m: DisplayMode) => {
      origSetMode(m);
      if (m === '3d' && !this.view3d) {
        this.view3d = new View3D(view3dEl);
        this.updateCameras3d();
      }
    };
    this.core.stage.append(
      view3dEl,
      modeButtons(this.core, true),
      presets,
      this.panel.toggle,
      this.panel.el,
      devinfo,
    );
    if (this.core.mode === '3d') this.core.setMode('3d');

    const status = h('div', { class: 'statusbar' });
    const start = h(
      'button',
      {
        class: 'btn primary',
        disabled: true,
        onclick: () => void (this.measuring ? this.stopMeasurement(null) : this.startMeasurement()),
      },
      '測定開始',
    );
    const testRec = h(
      'button',
      { class: 'btn', onclick: () => void this.toggleTestRecording() },
      'テスト録画',
    );
    const reason = h('div', { class: 'reason' });
    const menu = h('button', { class: 'btn ghost', onclick: () => this.openMenu() }, 'メニュー');
    root.appendChild(
      h(
        'div',
        { class: 'app' },
        status,
        this.core.stage,
        h('div', { class: 'toolbar' }, start, testRec, h('span', { class: 'grow' }), menu, reason),
      ),
    );
    this.el = { status, start, testRec, reason, devinfo };
  }

  // ---- MainContext ----
  saveCalib(c: StoredCalibration | null): void {
    this.calib = c;
    saveCalibration(c);
    this.rebuildFuser();
    this.updateCameras3d();
  }
  saveLayout(l: LayoutSelection): void {
    this.layoutSel = l;
    saveLayoutSelection(l);
  }
  onFused(cb: (f: FusedFrame) => void): () => void {
    this.fusedListeners.add(cb);
    return () => this.fusedListeners.delete(cb);
  }
  requestSubExtrinsics(timeoutMs: number): Promise<ExtrinsicsMsg> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingExtr = null;
        reject(new Error('副端末の外部校正の結果が届きません'));
      }, timeoutMs);
      this.pendingExtr = (m) => {
        clearTimeout(timer);
        this.pendingExtr = null;
        resolve(m);
      };
      if (!this.peer.sendCtrl({ type: 'calib-start' })) {
        clearTimeout(timer);
        reject(new Error('副端末と接続されていません'));
      }
    });
  }

  // ---- 起動 ----
  async start(): Promise<void> {
    try {
      await this.core.start((s) => (this.el.reason.textContent = s));
    } catch (e) {
      this.el.reason.textContent = (e as Error).message;
      await alertDialog('起動できません', (e as Error).message);
      return;
    }
    // カメラの使用許可を得てからRTCPeerConnectionを作る（spec 5.2.3）
    this.peer.onState = (s) => this.onPeerState(s);
    this.peer.onPose = (m) => this.onSubPose(m);
    this.peer.onCtrl = (m) => this.onCtrl(m);
    this.peer.start();
    this.core.onPose = (f) => this.scheduler.pushMain({ t: f.t, pose: f.pose, w: f.w, h: f.h });
    this.rebuildFuser();
    setInterval(() => this.pollFusion(), 15);
    setInterval(() => this.tickMonitor(), 100);
    setInterval(() => this.renderStatus(), 250);
    void storageStatus();
  }

  private onPeerState(s: PeerState): void {
    if (s !== 'connected') {
      this.sub.status = null;
    }
    this.renderStatus();
  }

  private onSubPose(m: PoseMsg): void {
    const now = nowMs();
    const pose = fromFlat(m.lm);
    this.sub.lastPose = pose;
    this.lastSubPoseAt = now;
    this.subRate.tick(now);
    this.scheduler.pushSub({ t: m.t, pose, w: m.w, h: m.h, seq: m.seq });
  }

  private onCtrl(m: CtrlMsg): void {
    switch (m.type) {
      case 'sync-req': {
        const t1 = nowMs();
        this.peer.sendCtrl(respondSync(m as SyncReq, t1, nowMs));
        break;
      }
      case 'hello':
        this.sub.deviceName = m.deviceName;
        this.sub.intr = m.intrinsics;
        this.sub.videoSize = m.videoSize;
        this.sub.cameraLabel = m.cameraLabel;
        this.rebuildFuser();
        break;
      case 'status':
        this.sub.status = m;
        break;
      case 'extrinsics':
        if (this.pendingExtr) this.pendingExtr(m);
        else
          toast(
            `副端末から外部校正の結果が届きました（${m.reprojErrPx.toFixed(2)}px）。主端末の「外部校正」から保存してください`,
          );
        break;
      case 'notice':
        toast(`副端末：${m.text}`, 4000);
        if (m.level === 'error' && this.pendingExtr) {
          // 外部校正の失敗
          this.pendingExtr = null;
        }
        break;
      case 'test-rec-done':
        if (!m.ok) toast(`副端末の録画に失敗しました：${m.error ?? ''}`);
        break;
      default:
        break;
    }
  }

  /** 校正の状態から統合処理を作り直す */
  private rebuildFuser(): void {
    const cams = this.cameras();
    this.fuser = cams ? new DltFuser(cams, this.cfg.params.fusion) : null;
  }

  private cameras(): { main: Camera; sub: Camera } | null {
    if (!this.calib || !this.core.intr || !this.sub.intr) return null;
    return {
      main: { intr: this.core.intr, extr: this.calib.main.extr },
      sub: { intr: this.sub.intr, extr: this.calib.sub.extr },
    };
  }

  private updateCameras3d(): void {
    this.view3d?.setCameras([
      { label: 'main', extr: this.calib?.main.extr ?? null, color: 0x3b82f6 },
      { label: 'sub', extr: this.calib?.sub.extr ?? null, color: 0xf97316 },
    ]);
  }

  /** 副端末のデータを待ってから統合する（spec 5.5 手順1） */
  private pollFusion(): void {
    const now = nowMs();
    for (const r of this.scheduler.poll(now)) {
      if (!this.fuser) {
        this.lastAngles = null;
        continue;
      }
      const { frame, joints } = fuseFrame(
        this.fuser,
        this.cfg.params.metrics,
        r.main.t,
        r.main.pose,
        r.sub.pose,
      );
      this.lastFused = joints;
      this.lastAngles = frame.angles;
      this.fusedRate.tick(now);
      this.latency.push(nowMs() - r.main.t);
      this.panel.update(frame.angles);
      if (this.core.mode === '3d') this.view3d?.setJoints(joints.joints, joints.fresh);
      this.core.invalidJoints = new Set(
        JOINT_INDICES.filter(
          (j) => r.main.pose && r.main.pose[j][2] >= this.cfg.params.fusion.minVisibility && !joints.fresh[j],
        ),
      );
      if (this.measuring && this.writer) {
        this.writer.add(toRecordFrame(frame));
        this.feedback.update(frame.t, frame.angles, joints);
      }
      for (const cb of this.fusedListeners) cb(joints);
    }
  }

  // ---- 測定の開始・停止 ----
  /** 開始できない理由（spec 5.9） */
  startBlockers(): string[] {
    const r: string[] = [];
    if (!this.peer.channelsOpen) r.push('副端末と接続されていません');
    if (!this.core.intr) r.push(`主端末の内部パラメータ（${this.core.deviceName}）がありません`);
    if (this.peer.channelsOpen && !this.sub.intr)
      r.push(`副端末の内部パラメータ（${this.sub.deviceName ?? '?'}）がありません`);
    if (!this.calib) r.push('外部校正がまだです');
    if (this.core.intr && !this.core.resolutionOk)
      r.push(
        `主端末の解像度（${this.core.cam?.width}×${this.core.cam?.height}）が校正時（${this.core.intr.imageSize.join('×')}）と一致しません`,
      );
    if (
      this.sub.intr &&
      this.sub.videoSize &&
      (this.sub.intr.imageSize[0] !== this.sub.videoSize[0] ||
        this.sub.intr.imageSize[1] !== this.sub.videoSize[1])
    )
      r.push(
        `副端末の解像度（${this.sub.videoSize.join('×')}）が校正時（${this.sub.intr.imageSize.join('×')}）と一致しません`,
      );
    if (
      this.calib &&
      this.core.cam &&
      (this.calib.main.videoSize[0] !== this.core.cam.width ||
        this.calib.main.videoSize[1] !== this.core.cam.height)
    )
      r.push('外部校正のときと主端末の解像度が違います');
    if (this.calib && this.sub.deviceName && this.calib.sub.deviceName !== this.sub.deviceName)
      r.push(
        `外部校正のときと副端末のdeviceNameが違います（${this.calib.sub.deviceName} → ${this.sub.deviceName}）`,
      );
    if (this.peer.channelsOpen && !this.sub.status?.synced) r.push('時刻同期が終わっていません');
    return r;
  }

  private async startMeasurement(): Promise<void> {
    const blockers = this.startBlockers();
    if (blockers.length) return void toast(blockers[0]);
    // iOSの制限のため、タップのときに音声を有効化しておく
    this.alarm.unlock();
    this.speaker.unlock();
    await this.core.wakeLock.acquire();
    const cd = loadJson<number>(KEYS.countdown, 0);
    if (cd > 0) {
      const el = h('div', { class: 'countdown' }, String(cd));
      this.core.stage.appendChild(el);
      for (let i = cd; i > 0; i--) {
        el.textContent = String(i);
        await new Promise((r) => setTimeout(r, 1000));
      }
      el.remove();
      const again = this.startBlockers();
      if (again.length) return void toast(again[0]);
    }
    const startedAt = nowMs();
    const subj = loadSubject();
    const cams = this.cameras()!;
    const header: Omit<Session, 'frames'> = {
      version: 1,
      id: sessionIdFromTime(startedAt),
      source: 'realtime',
      startedAt,
      endedAt: null,
      aborted: null,
      subject: { id: subj.id, heightM: subj.heightM, note: subj.note },
      trial: { label: subj.trialLabel },
      devices: {
        main: {
          deviceName: this.core.deviceName,
          intrinsics: cams.main.intr,
          extrinsics: cams.main.extr,
          videoSize: [this.core.cam!.width, this.core.cam!.height],
        },
        sub: {
          deviceName: this.sub.deviceName ?? '',
          intrinsics: cams.sub.intr,
          extrinsics: cams.sub.extr,
          videoSize: this.sub.videoSize ?? [0, 0],
        },
      },
      layout: {
        presetId: this.layoutSel.presetId,
        planned: { main: this.layoutSel.main, sub: this.layoutSel.sub },
        measured: this.calib!.measured,
      },
      params: this.cfg.params,
      jointIndices: JOINT_INDICES,
      video: null,
    };
    try {
      this.writer = await SessionWriter.begin(header, this.cfg.params.recording.frameFlushCount);
    } catch (e) {
      return void alertDialog('記録を開始できません', (e as Error).message);
    }
    this.rebuildFuser();
    this.feedback.reset();
    if (loadJson(KEYS.recordVideo, this.cfg.params.recording.recordVideo) && this.core.cam) {
      try {
        this.recorder.start(this.core.cam.stream);
      } catch (e) {
        toast(`録画を開始できませんでした：${(e as Error).message}`);
      }
    }
    this.monitor.start(nowMs());
    this.measuring = true;
    this.renderStatus();
  }

  private async stopMeasurement(aborted: AbortInfo | null): Promise<void> {
    if (!this.measuring) return;
    this.measuring = false;
    const endedAt = nowMs();
    const w = this.writer;
    this.writer = null;
    let video: Blob | null = null;
    let videoInfo: Session['video'] = null;
    if (this.recorder.recording) {
      videoInfo = { startedAt: this.recorder.startedAtLocal, mimeType: this.recorder.mimeType };
      video = await this.recorder.stop();
    }
    await this.core.wakeLock.release();
    if (w) {
      try {
        await w.finish(endedAt, aborted, video, { video: video ? videoInfo : null });
        toast(`記録を保存しました（${w.frameCount}フレーム）`);
      } catch (e) {
        await alertDialog('記録を保存できませんでした', (e as Error).message);
      }
    }
    this.renderStatus();
  }

  /** 異常の監視（spec 5.9） */
  private tickMonitor(): void {
    if (!this.measuring) return;
    const now = nowMs();
    const minVis = this.cfg.params.fusion.minVisibility;
    const r = this.monitor.update({
      now,
      channelOpen: this.peer.channelsOpen,
      lastSubPoseAt: this.lastSubPoseAt,
      mainRequiredVisible: requiredVisible(this.core.lastPose, minVis),
      subRequiredVisible: requiredVisible(this.sub.lastPose, minVis),
      reprojErrPx: this.lastFused?.quality.reprojErrPx ?? null,
      mainFps: this.core.rate.rate(now),
      subFps: this.subRate.rate(now),
      rttMs: this.sub.status?.probeRttMs ?? null,
    });
    if (r) {
      this.alarm.play();
      void this.stopMeasurement(r);
      void alertDialog('測定を中止しました', ABORT_MESSAGES[r.reason], r.detail);
    }
  }

  // ---- テスト録画（spec 5.10.1） ----
  private async toggleTestRecording(): Promise<void> {
    if (!this.testRecorder.recording) {
      if (!this.core.cam) return;
      if (!this.peer.sendCtrl({ type: 'test-rec-start' }))
        toast('副端末と接続されていないため、主端末だけで録画します');
      this.testRecorder.start(this.core.cam.stream);
      this.el.testRec.textContent = '録画停止';
      this.el.testRec.classList.add('danger');
      this.renderStatus();
      return;
    }
    this.peer.sendCtrl({ type: 'test-rec-stop' });
    const startedAt = this.testRecorder.startedAtLocal;
    const mimeType = this.testRecorder.mimeType;
    const blob = await this.testRecorder.stop();
    this.el.testRec.textContent = 'テスト録画';
    this.el.testRec.classList.remove('danger');
    if (!blob) return void toast('録画データがありません');
    const meta: RecordingMeta = {
      role: 'main',
      deviceName: this.core.deviceName,
      intrinsics: this.core.intr,
      recordStartedAt: startedAt,
      videoSize: [this.core.cam!.width, this.core.cam!.height],
      mimeType,
      cameraLabel: this.core.cam?.label,
      clockOffsetMs: 0,
    };
    const ext = videoExt(mimeType);
    openSheet('テスト録画のダウンロード', (body) => {
      body.append(
        h(
          'p',
          {},
          `録画しました（${(blob.size / 1e6).toFixed(1)}MB、${mimeType}）。副端末でもダウンロードしてください。`,
        ),
        h(
          'div',
          { class: 'menu' },
          h(
            'button',
            { class: 'btn primary', onclick: () => downloadBlob(blob, `main.${ext}`) },
            `main.${ext}`,
          ),
          h(
            'button',
            { class: 'btn', onclick: () => downloadJson(meta, 'main-meta.json') },
            'main-meta.json',
          ),
          h('button', { class: 'btn', onclick: () => this.exportCalibration() }, 'calibration.json'),
        ),
      );
    });
  }

  exportCalibration(): void {
    if (!this.calib) return void toast('外部校正がまだです');
    const f: CalibrationFile = {
      version: 1,
      createdAt: Date.now(),
      main: {
        deviceName: this.calib.main.deviceName,
        intrinsics: this.core.intr,
        extrinsics: this.calib.main.extr,
        videoSize: this.calib.main.videoSize,
      },
      sub: {
        deviceName: this.calib.sub.deviceName,
        intrinsics: this.sub.intr,
        extrinsics: this.calib.sub.extr,
        videoSize: this.calib.sub.videoSize,
      },
      layout: { planned: this.layoutSel, measured: this.calib.measured },
    };
    downloadJson(f, 'calibration.json');
  }

  private openMenu(): void {
    openSheet('メニュー', (body, sheet) => {
      const go = (fn: () => void) => () => {
        sheet.close();
        fn();
      };
      body.append(
        h(
          'div',
          { class: 'menu' },
          h(
            'button',
            { class: 'btn', onclick: go(() => openSessions(this.cfg.params.fusion.minVisibility)) },
            'セッション一覧',
          ),
          h('button', { class: 'btn', onclick: go(() => openLayoutScreen(this)) }, 'カメラ配置'),
          h('button', { class: 'btn', onclick: go(() => openExtrinsicsScreen(this)) }, '外部校正'),
          h('button', { class: 'btn', onclick: go(() => openCalibCheck(this)) }, '校正の確認'),
          h('button', { class: 'btn', onclick: go(() => openCalibCapture(this.core)) }, '校正画像撮影'),
          h(
            'button',
            {
              class: 'btn',
              onclick: go(() =>
                openSettings(this.core, { main: true, onChanged: () => this.rebuildFuser() }),
              ),
            },
            '設定',
          ),
          h('button', { class: 'btn', onclick: () => this.exportCalibration() }, 'calibration.json'),
          h('a', { class: 'btn', href: '/offline.html', target: '_blank' }, 'オフラインモード'),
        ),
      );
      if (this.calib)
        body.appendChild(
          h(
            'button',
            {
              class: 'btn ghost',
              style: 'margin-top:12px',
              onclick: () => {
                if (confirm('保存した外部校正の結果を消しますか？')) this.saveCalib(null);
              },
            },
            '外部校正の結果を消す',
          ),
        );
    });
  }

  /** 受信の通信量（kB/秒、約1秒ごとに更新） */
  private bytesRate(now: number): number {
    const b = this.bytesPrev;
    if (now - b.t >= 1000) {
      b.rate = b.t ? (this.peer.bytesIn - b.bytes) / (now - b.t) : 0;
      b.bytes = this.peer.bytesIn;
      b.t = now;
    }
    return b.rate;
  }

  // ---- 状態の表示 ----
  private renderStatus(): void {
    const now = nowMs();
    const ps = this.peer.state;
    const conn = ps === 'connected' ? 'ok' : ps === 'rejected' ? 'bad' : 'warn';
    const connLabel = {
      idle: '待機',
      signaling: 'サーバー接続中',
      'waiting-peer': '副端末を待機中',
      connecting: '接続中',
      connected: '接続済み',
      disconnected: '切断',
      rejected: '主端末が既にあります',
    }[ps];
    const st = this.sub.status;
    const sync = st?.synced
      ? `ずれ${fmtNum(st.offsetMs, 0)}ms 往復${fmtNum(st.probeRttMs ?? st.rttMs, 0)}ms`
      : '時刻同期：未';
    const fpsMain = this.core.rate.rate(now);
    const fpsSub = this.subRate.rate(now);
    const calib = this.calib && this.core.intr && this.sub.intr ? 'ok' : this.calib ? 'warn' : 'bad';
    const items = [
      h('span', { class: 'item' }, h('i', { class: `dot ${conn}` }), connLabel),
      h(
        'span',
        { class: 'item' },
        h('i', {
          class: `dot ${st?.synced ? ((st.probeRttMs ?? 0) > this.cfg.params.monitor.maxRttMs ? 'warn' : 'ok') : 'bad'}`,
        }),
        sync,
      ),
      h('span', { class: 'item' }, `主${fmtNum(fpsMain, 1)}fps 副${fmtNum(fpsSub, 1)}fps`),
      h('span', { class: 'item' }, h('i', { class: `dot ${calib}` }), this.calib ? '校正済み' : '未校正'),
      this.measuring ? h('span', { class: 'badge meas' }, '測定中') : null,
      this.recorder.recording || this.testRecorder.recording
        ? h('span', { class: 'badge rec' }, '● 録画中')
        : null,
    ];
    this.el.status.replaceChildren(...items.filter((x): x is HTMLElement => !!x));
    this.el.start.textContent = this.measuring ? '測定停止' : '測定開始';
    this.el.start.className = this.measuring ? 'btn danger' : 'btn primary';
    const blockers = this.measuring ? [] : this.startBlockers();
    this.el.start.disabled = !this.measuring && blockers.length > 0;
    if (!this.core.error)
      this.el.reason.textContent = blockers.length ? `開始できません：${blockers.join(' ／ ')}` : '';
    else this.el.reason.textContent = `エラー：${this.core.error}`;
    // 開発者向けの情報
    const azm =
      this.calib && this.lastFused
        ? cameraAzimuthInBody(this.lastFused.joints, cameraCenter(this.calib.main.extr))
        : null;
    this.el.devinfo.textContent = [
      `推論 ${fmtNum(this.core.inferMs.value, 0)}ms (${this.core.est?.delegate ?? '—'})`,
      `副 推論 ${fmtNum(st?.inferMs ?? null, 0)}ms`,
      `撮影→統合 ${fmtNum(this.latency.value, 0)}ms`,
      `統合 ${fmtNum(this.fusedRate.rate(now), 1)}fps`,
      `再投影 ${fmtNum(this.lastFused?.quality.reprojErrPx ?? null, 1)}px`,
      `関節 ${this.lastFused?.quality.validJoints ?? '—'}${this.lastFused?.quality.swapApplied ? ' 左右補正' : ''}`,
      azm !== null ? `主カメラ方位 ${azm.toFixed(0)}°` : '',
      `受信 ${this.bytesRate(now).toFixed(1)}kB/s`,
    ]
      .filter(Boolean)
      .join('\n');
    if (!this.lastAngles) this.panel.update(null);
  }
}

export type { Pose2D };
