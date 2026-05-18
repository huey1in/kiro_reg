// ===== 任务控制 + 更新系统 + 状态轮询 =====

function formatTime(seconds) {
  seconds = Math.round(seconds);
  if (seconds < 60) return seconds + 's';
  var m = Math.floor(seconds / 60);
  var s = seconds % 60;
  if (m < 60) return m + 'm ' + s + 's';
  var h = Math.floor(m / 60);
  m = m % 60;
  return h + 'h ' + m + 'm';
}

// 任务模态框（保留兼容，已迁移到注册页面）
function openKiroTaskModal() { switchPage('register'); }
function closeKiroTaskModal() {}

var updateInfo = null;
var _prevRunning = false;
window._kiroLogs = [];

function _escapeLogHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// 将一行日志解析为带高亮 span 的 HTML。
// 识别模式: "HH:MM:SS [prefix] [step] rest"
function _formatLogLine(line) {
  var raw = line.replace(/\r?\n$/, '');
  if (!raw) return '';

  // 整行级别判定
  var low = raw.toLowerCase();
  var cls = 'log-line';
  if (raw.indexOf('注册成功') >= 0 || raw.indexOf('已验活') >= 0 || raw.indexOf('[OK]') >= 0) {
    cls += ' log-line-success';
  } else if (raw.indexOf('失败') >= 0 || raw.indexOf('错误') >= 0 || raw.indexOf('异常') >= 0 ||
             raw.indexOf('被拦截') >= 0 || raw.indexOf('被封') >= 0 ||
             low.indexOf('error') >= 0 || low.indexOf('failed') >= 0) {
    cls += ' log-line-error';
  } else if (raw.indexOf('⚠') >= 0 || raw.indexOf('熔断') >= 0 || raw.indexOf('重试') >= 0) {
    cls += ' log-line-warn';
  } else if (raw.indexOf('[DEBUG]') >= 0) {
    cls += ' log-line-debug';
  }

  // 分段高亮: 时间戳 + [标签] + [step] + 其余
  var html = '';
  var rest = raw;

  var m = rest.match(/^(\d{2}:\d{2}:\d{2})\s*/);
  if (m) {
    html += '<span class="log-time">' + _escapeLogHtml(m[1]) + '</span>';
    rest = rest.slice(m[0].length);
  }

  // 匹配若干 [xxx] 前缀，时间戳之后的所有方括号标签
  while (true) {
    var t = rest.match(/^(\[[^\]]+\])\s*/);
    if (!t) break;
    var label = t[1];
    // 纯数字步骤如 [1] [12.5] 用 step 色，其余用 tag 色
    var inner = label.slice(1, -1);
    var isStep = /^\d+(\.\d+)?(\/\d+)?$/.test(inner);
    html += '<span class="' + (isStep ? 'log-step' : 'log-tag') + '">' +
      _escapeLogHtml(label) + '</span>';
    rest = rest.slice(t[0].length);
  }

  html += _escapeLogHtml(rest);
  return '<span class="' + cls + '">' + html + '</span>';
}

function renderUnifiedLogs() {
  var box = document.getElementById('unified-log-box');
  if (!box) return;

  // 首次渲染时挂上行级点击复制（事件委托，后续 innerHTML 重写不会丢）
  if (!box.dataset.copyBound) {
    box.addEventListener('click', function(e) {
      var line = e.target.closest('.log-line');
      if (!line || !box.contains(line)) return;
      // 如果用户正在选中文字，让选择行为优先，不触发行复制
      var sel = window.getSelection && window.getSelection();
      if (sel && sel.toString().length > 0) return;
      var text = line.textContent.replace(/\u00A0/g, ' ').trim();
      if (!text) return;
      navigator.clipboard.writeText(text).then(function() {
        line.classList.add('log-copied');
        setTimeout(function() { line.classList.remove('log-copied'); }, 600);
        if (typeof showToast === 'function') showToast('复制成功', 'success');
      }).catch(function(err) {
        if (typeof showToast === 'function') showToast('复制失败: ' + err.message, 'error');
      });
    });
    box.dataset.copyBound = '1';
  }

  var wasAtBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 50;

  var logs = window._kiroLogs || [];
  var html;
  if (!logs.length) {
    html = '<span style="color:var(--text-muted);">暂无日志</span>';
  } else {
    html = logs.map(function(l) {
      return _formatLogLine(l.replace(/^\s+/, ''));
    }).join('\n');
  }

  if (box.innerHTML !== html) {
    box.innerHTML = html;
    if (wasAtBottom) box.scrollTop = box.scrollHeight;
  }
}

function copyLogs() {
  var box = document.getElementById('unified-log-box');
  if (!box) return;
  
  var text = box.textContent;
  if (!text || text === '暂无日志') {
    showToast('暂无日志可复制', 'error');
    return;
  }
  
  navigator.clipboard.writeText(text).then(function() {
    showToast('日志已复制到剪贴板', 'success');
  }).catch(function(e) {
    showToast('复制失败: ' + e.message, 'error');
  });
}

function notifyTaskComplete(taskName, success, failed, total) {
  var msg = taskName + ' 任务完成！成功 ' + success + ' / 失败 ' + failed + ' / 共 ' + total;
  showToast(msg, success > 0 ? 'success' : 'error');
  // 提示音（3声短促蜂鸣），受设置开关控制
  var soundEnabled = document.getElementById('cfg-sound');
  if (soundEnabled && soundEnabled.checked) {
    try {
      var ctx = new (window.AudioContext || window.webkitAudioContext)();
      [0, 200, 400].forEach(function(delay) {
        var osc = ctx.createOscillator();
        var gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.frequency.value = 880;
        gain.gain.value = 0.3;
        osc.start(ctx.currentTime + delay / 1000);
        osc.stop(ctx.currentTime + delay / 1000 + 0.1);
      });
    } catch(e) {}
  }
}

async function startTask() {
  try {
    var cfg = getFormConfig();

    if (cfg.useOutlook) {
      saveConfig();
    }

    var result = await window.go.main.App.StartTask(cfg);
    if (result.error) {
      showToast(result.error, 'error');
      return;
    }
    updateUIStatus(true);
    showToast('任务已启动');
  } catch(e) {
    showToast('启动失败: ' + e.message, 'error');
  }
}

var _confirmCallback = null;

function showConfirmModal(title, message, btnText, callback) {
  document.getElementById('confirm-title').textContent = title;
  document.getElementById('confirm-message').textContent = message;
  document.getElementById('confirm-action-btn').textContent = btnText || '确认';
  _confirmCallback = callback;
  document.getElementById('confirm-modal').classList.add('show');
}

function closeConfirmModal() {
  document.getElementById('confirm-modal').classList.remove('show');
  _confirmCallback = null;
}

function confirmAction() {
  var cb = _confirmCallback;
  closeConfirmModal();
  if (cb) cb();
}

async function stopTask() {
  try {
    var result = await window.go.main.App.StopTask();
    if (result.error) { 
      showToast(result.error, 'error'); 
      return; 
    }
    document.getElementById('btn-stop').disabled = true;
    showToast('正在停止任务...');
  } catch(e) {
    showToast('停止失败: ' + (e.message || e), 'error');
  }
}

// ===== 更新系统 =====

if (window.runtime) {
  window.runtime.EventsOn('update-available', function(data) {
    updateInfo = data;
    showUpdateModal(data);
  });
  window.runtime.EventsOn('update-progress', function(progress, downloaded, total) {
    updateDownloadProgress(progress, downloaded, total);
  });
}

function showUpdateModal(data) {
  document.getElementById('update-current-version').textContent = data.currentVersion || '-';
  document.getElementById('update-latest-version').textContent = data.latestVersion || data.version || '-';
  document.getElementById('update-release-date').textContent = data.releaseDate || '-';
  document.getElementById('update-changelog').textContent = data.changelog || '-';

  // 记下 release 页面地址供「前往下载」按钮使用
  window._latestReleaseURL = data.releaseURL || 'https://github.com/huey1in/kirox/releases/latest';

  document.getElementById('update-modal').classList.add('show');
}

async function closeUpdateModal() {
  document.getElementById('update-modal').classList.remove('show');
}

function openReleasePage() {
  var url = window._latestReleaseURL || 'https://github.com/huey1in/kirox/releases/latest';
  if (window.go && window.go.main && window.go.main.App && window.go.main.App.OpenURL) {
    window.go.main.App.OpenURL(url);
  } else {
    window.open(url, '_blank');
  }
}

async function checkUpdateManually() {
  try {
    var result = await window.go.main.App.CheckUpdate();
    if (result.error) {
      showToast(result.error, 'error');
      return;
    }
    if (result.hasUpdate) {
      updateInfo = result;
      showUpdateModal(result);
    } else {
      showToast('当前已是最新版本');
    }
  } catch(e) {
    showToast('检查更新失败: ' + e.message, 'error');
  }
}

// ===== 状态轮询 =====

var lastOutlookUpdate = 0;
setInterval(async function() {
  try {
    var s = await window.go.main.App.GetStatus();
    updateUIStatus(s.running);
    // 注册页状态徽章
    var regBadge = document.getElementById('reg-status-badge');
    if (regBadge) {
      regBadge.textContent = s.running ? '运行中' : '空闲';
      regBadge.className = 'db-badge ' + (s.running ? 'db-badge-running' : 'db-badge-idle');
    }
    document.getElementById('st-progress').textContent = s.completed + '/' + s.total;
    document.getElementById('st-success').textContent = s.success;
    document.getElementById('st-failed').textContent = s.failed;
    if (s.elapsed > 0) document.getElementById('st-elapsed').textContent = formatTime(s.elapsed);
    var pct = s.total > 0 ? Math.round(s.completed / s.total * 100) : 0;
    document.getElementById('progress-bar').style.width = pct + '%';
    // 检测任务完成
    if (_prevRunning && !s.running && s.completed > 0) {
      notifyTaskComplete('Kiro', s.success, s.failed, s.completed);
    }
    _prevRunning = s.running;
    // 状态指示灯
    var dot = document.getElementById('st-dot');
    if (s.running) { dot.classList.add('running'); } else { dot.classList.remove('running'); }
    // 平均耗时
    var avgEl = document.getElementById('st-avg');
    if (s.completed > 0 && s.elapsed > 0) {
      avgEl.textContent = (s.elapsed / s.completed).toFixed(1) + 's';
    } else {
      avgEl.textContent = '-';
    }
    // 成功率
    var rateEl = document.getElementById('st-rate');
    if (s.completed > 0) {
      rateEl.textContent = Math.round(s.success / s.completed * 100) + '%';
      rateEl.style.color = s.success > 0 ? 'var(--success)' : 'var(--danger)';
    } else {
      rateEl.textContent = '-';
      rateEl.style.color = '';
    }
    // 预计剩余
    var etaEl = document.getElementById('st-eta');
    if (s.running && s.completed > 0 && s.total > s.completed) {
      var avgTime = s.elapsed / s.completed;
      var remaining = (s.total - s.completed) * avgTime;
      etaEl.textContent = formatTime(remaining);
    } else {
      etaEl.textContent = '-';
    }
  } catch(e) {}
  try {
    var kiroLogs = await window.go.main.App.GetLogs() || [];
    window._kiroLogs = kiroLogs;
    renderUnifiedLogs();
  } catch(e) {}

  var now = Date.now();
  if (now - lastOutlookUpdate > 2000) {
    lastOutlookUpdate = now;
    var outlookModal = document.getElementById('outlook-modal');
    if (outlookModal && outlookModal.classList.contains('show')) {
      await loadOutlookAccountsList();
    }
  }
}, 2000);
