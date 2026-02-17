const API_SIGN_ENDPOINT = '/api/signatures/pades';
const MAX_PDF_SIZE = 10 * 1024 * 1024;
const DB_NAME = 'pdf-sign-secure-queue';
const STORE = 'jobs';

const el = {
  pdfFile: document.getElementById('pdfFile'),
  fileInfo: document.getElementById('fileInfo'),
  fullName: document.getElementById('fullName'),
  cpf: document.getElementById('cpf'),
  phone: document.getElementById('phone'),
  signDate: document.getElementById('signDate'),
  signatureCanvas: document.getElementById('signatureCanvas'),
  clearSignature: document.getElementById('clearSignature'),
  saveDraft: document.getElementById('saveDraft'),
  signAndSend: document.getElementById('signAndSend'),
  retryQueue: document.getElementById('retryQueue'),
  status: document.getElementById('status'),
  queueList: document.getElementById('queueList'),
  queueItemTpl: document.getElementById('queueItemTpl'),
  networkBadge: document.getElementById('networkBadge'),
};

const state = {
  file: null,
  signatureEmpty: true,
  signaturePad: null,
};

init();

async function init() {
  bindInputs();
  initSignaturePad();
  refreshNetworkBadge();
  await renderQueue();
  if (navigator.onLine) {
    retryPending().catch(() => {});
  }
}

function bindInputs() {
  el.pdfFile.addEventListener('change', onPdfSelected);
  el.clearSignature.addEventListener('click', () => state.signaturePad.clear());
  el.saveDraft.addEventListener('click', onSaveDraft);
  el.signAndSend.addEventListener('click', onSignAndSend);
  el.retryQueue.addEventListener('click', () => retryPending(true));

  window.addEventListener('online', () => {
    refreshNetworkBadge();
    retryPending().catch(() => {});
  });
  window.addEventListener('offline', refreshNetworkBadge);

  el.cpf.addEventListener('input', () => {
    el.cpf.value = formatCpf(el.cpf.value);
  });

  el.phone.addEventListener('input', () => {
    el.phone.value = formatPhone(el.phone.value);
  });
}

function refreshNetworkBadge() {
  const online = navigator.onLine;
  el.networkBadge.textContent = online ? 'Online' : 'Offline';
  el.networkBadge.className = `badge ${online ? 'badge-online' : 'badge-offline'}`;
}

function onPdfSelected(evt) {
  const file = evt.target.files?.[0];
  if (!file) return;

  if (file.type !== 'application/pdf') {
    setStatus('Arquivo inválido. Selecione um PDF.', true);
    evt.target.value = '';
    return;
  }

  if (file.size > MAX_PDF_SIZE) {
    setStatus('PDF excede 10 MB.', true);
    evt.target.value = '';
    return;
  }

  state.file = file;
  el.fileInfo.textContent = `${safeText(file.name)} · ${(file.size / 1024 / 1024).toFixed(2)} MB`;
  setStatus('PDF carregado com sucesso.');
}

function initSignaturePad() {
  const canvas = el.signatureCanvas;
  const ctx = canvas.getContext('2d');

  const resize = () => {
    const ratio = Math.max(window.devicePixelRatio || 1, 1);
    canvas.width = Math.floor(canvas.clientWidth * ratio);
    canvas.height = Math.floor(canvas.clientHeight * ratio);
    ctx.scale(ratio, ratio);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#0f172a';
    state.signaturePad.clear();
  };

  state.signaturePad = createSimplePad(canvas, ctx, () => {
    state.signatureEmpty = false;
  }, () => {
    state.signatureEmpty = true;
  });

  window.addEventListener('resize', resize);
  resize();
}

function createSimplePad(canvas, ctx, onMarkDrawn, onClear) {
  let drawing = false;
  let lastX = 0;
  let lastY = 0;

  const point = (event) => {
    const rect = canvas.getBoundingClientRect();
    return {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    };
  };

  const start = (event) => {
    drawing = true;
    const p = point(event);
    lastX = p.x;
    lastY = p.y;
    canvas.setPointerCapture(event.pointerId);
  };

  const move = (event) => {
    if (!drawing) return;
    const p = point(event);
    ctx.beginPath();
    ctx.moveTo(lastX, lastY);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    lastX = p.x;
    lastY = p.y;
    onMarkDrawn();
  };

  const end = (event) => {
    drawing = false;
    if (event.pointerId !== undefined) {
      canvas.releasePointerCapture(event.pointerId);
    }
  };

  canvas.addEventListener('pointerdown', start);
  canvas.addEventListener('pointermove', move);
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);

  return {
    isEmpty: () => state.signatureEmpty,
    clear: () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      onClear();
    },
    toBlob: () => new Promise((resolve) => canvas.toBlob(resolve, 'image/png', 0.95)),
  };
}

async function onSaveDraft() {
  try {
    const payload = await buildPayload();
    await queueJob(payload, 'draft');
    setStatus('Rascunho salvo com segurança na fila local.');
    await renderQueue();
  } catch (err) {
    setStatus(err.message, true);
  }
}

async function onSignAndSend() {
  try {
    const payload = await buildPayload();
    await sendToBackend(payload);
    setStatus('Documento enviado. Assinatura final será aplicada no backend (PAdES).');
  } catch (err) {
    const message = navigator.onLine
      ? `Falha no envio: ${err.message}`
      : 'Sem internet. Documento guardado para reenvio automático.';

    setStatus(message, true);

    if (!navigator.onLine || err.retryable) {
      const payload = await buildPayload();
      await queueJob(payload, 'pending');
      await renderQueue();
    }
  }
}

async function buildPayload() {
  validateForm();

  const pdfArrayBuffer = await state.file.arrayBuffer();
  const pdfHashHex = await sha256Hex(pdfArrayBuffer);
  const signatureBlob = await state.signaturePad.toBlob();
  if (!signatureBlob) throw new Error('Não foi possível gerar rubrica visual.');

  return {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    metadata: {
      name: safeText(el.fullName.value.trim()),
      cpf: el.cpf.value.trim(),
      phone: el.phone.value.trim(),
      signDate: el.signDate.value,
      pdfName: safeText(state.file.name),
      pdfHashSha256: pdfHashHex,
      userAgent: navigator.userAgent,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    },
    pdfFile: state.file,
    signatureBlob,
  };
}

function validateForm() {
  if (!state.file) throw new Error('Selecione um PDF antes de continuar.');

  const name = el.fullName.value.trim();
  if (name.length < 4) throw new Error('Informe nome completo válido.');

  const cpf = onlyDigits(el.cpf.value);
  if (!isValidCpf(cpf)) throw new Error('CPF inválido.');

  const phone = onlyDigits(el.phone.value);
  if (phone.length < 10 || phone.length > 11) throw new Error('Telefone inválido.');

  if (!el.signDate.value) throw new Error('Informe a data de assinatura.');

  if (state.signaturePad.isEmpty()) throw new Error('Rubrique no campo de assinatura.');
}

async function sendToBackend(payload) {
  if (!navigator.onLine) {
    const error = new Error('Sem conexão com internet.');
    error.retryable = true;
    throw error;
  }

  const formData = new FormData();
  formData.append('requestId', payload.id);
  formData.append('metadata', JSON.stringify(payload.metadata));
  formData.append('pdf', payload.pdfFile, payload.metadata.pdfName);
  formData.append('signatureImage', payload.signatureBlob, 'rubrica.png');

  const response = await fetch(API_SIGN_ENDPOINT, {
    method: 'POST',
    body: formData,
    headers: {
      'X-Content-Integrity': payload.metadata.pdfHashSha256,
    },
  });

  if (!response.ok) {
    const bodyText = await response.text().catch(() => '');
    const error = new Error(`Servidor recusou (${response.status}). ${bodyText}`.trim());
    error.retryable = response.status >= 500;
    throw error;
  }

  const signedPdfBlob = await response.blob();
  downloadBlob(signedPdfBlob, `${payload.metadata.name.replace(/\s+/g, '_')}_assinado.pdf`);
}

async function retryPending(showStatus = false) {
  const jobs = await readJobs();
  const pendings = jobs.filter((job) => job.state === 'pending');

  if (!pendings.length) {
    if (showStatus) setStatus('Nenhuma pendência na fila.');
    return;
  }

  let sent = 0;
  for (const job of pendings) {
    try {
      await sendToBackend(job.payload);
      await deleteJob(job.id);
      sent += 1;
    } catch {
      // mantém pendência para próxima tentativa
    }
  }

  await renderQueue();
  if (showStatus) setStatus(`${sent} pendência(s) reenviada(s) com sucesso.`);
}

function setStatus(message, isError = false) {
  el.status.textContent = message;
  el.status.style.color = isError ? 'var(--danger)' : 'var(--ok)';
}

function formatCpf(v) {
  const d = onlyDigits(v).slice(0, 11);
  return d
    .replace(/(\d{3})(\d)/, '$1.$2')
    .replace(/(\d{3})(\d)/, '$1.$2')
    .replace(/(\d{3})(\d{1,2})$/, '$1-$2');
}

function formatPhone(v) {
  const d = onlyDigits(v).slice(0, 11);
  if (d.length <= 10) {
    return d.replace(/(\d{2})(\d)/, '($1) $2').replace(/(\d{4})(\d{1,4})$/, '$1-$2');
  }
  return d.replace(/(\d{2})(\d)/, '($1) $2').replace(/(\d{5})(\d{1,4})$/, '$1-$2');
}

function isValidCpf(cpf) {
  if (!cpf || cpf.length !== 11 || /^(\d)\1+$/.test(cpf)) return false;

  const checkDigit = (base, factor) => {
    let total = 0;
    for (const n of base) total += Number(n) * factor--;
    const mod = (total * 10) % 11;
    return mod === 10 ? 0 : mod;
  };

  const first = checkDigit(cpf.slice(0, 9), 10);
  const second = checkDigit(cpf.slice(0, 10), 11);
  return first === Number(cpf[9]) && second === Number(cpf[10]);
}

function onlyDigits(v) {
  return (v || '').replace(/\D/g, '');
}

function safeText(v) {
  return (v || '').replace(/[<>]/g, '').slice(0, 160);
}

async function sha256Hex(arrayBuffer) {
  const hashBuffer = await crypto.subtle.digest('SHA-256', arrayBuffer);
  return [...new Uint8Array(hashBuffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function queueJob(payload, stateName) {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put({ id: payload.id, state: stateName, payload });
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

async function readJobs() {
  const db = await openDb();
  const rows = await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return rows;
}

async function deleteJob(id) {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

async function renderQueue() {
  const jobs = await readJobs();
  el.queueList.innerHTML = '';

  if (!jobs.length) {
    const li = document.createElement('li');
    li.textContent = 'Fila vazia';
    el.queueList.appendChild(li);
    return;
  }

  jobs.forEach((job) => {
    const node = el.queueItemTpl.content.firstElementChild.cloneNode(true);
    node.querySelector('.name').textContent = `${job.payload.metadata.name} (${job.payload.metadata.pdfName})`;
    node.querySelector('.state').textContent = job.state;
    el.queueList.appendChild(node);
  });
}
