/* Codexfy — Auth, Notifications, User Menu, Theme, Logs, Export, Shortcuts */
(function(){
'use strict';

// ── API helpers (same base as app.js) ──
const API_BASE = window.location.origin + '/api/v1';

async function authApi(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(API_BASE + path, opts);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw d;
  return d;
}

// ── Token refresh helper ──
async function tryRefreshToken() {
  const refresh = localStorage.getItem('cg_refresh_token');
  if (!refresh) return false;
  try {
    const res = await authApi('POST', '/auth/refresh', { refresh_token: refresh });
    localStorage.setItem('cx_token', res.access_token);
    localStorage.setItem('cg_token', res.access_token);
    localStorage.setItem('cg_refresh_token', res.refresh_token);
    try {
      const payload = JSON.parse(atob(res.access_token.split('.')[1]));
      if (payload.org_id) localStorage.setItem('cg_org_id', payload.org_id);
    } catch(_){}
    return true;
  } catch(_) {
    return false;
  }
}

// ── Force logout (exposed globally for app.js) ──
function forceLogout() {
  localStorage.removeItem('cx_token'); localStorage.removeItem('cx_name'); localStorage.removeItem('cx_email');
  localStorage.removeItem('cg_token'); localStorage.removeItem('cg_org_id'); localStorage.removeItem('cg_refresh_token');
  showAuth();
}
window.CodexfyForceLogout = forceLogout;
window.CodexfyRefreshToken = tryRefreshToken;

const $=id=>document.getElementById(id);
const authScreen=$('authScreen'), appEl=$('app');
const loginForm=$('loginForm'), regForm=$('registerForm');
const notifDropdown=$('notifDropdown'), userDropdown=$('userDropdown');
const kbdOverlay=$('kbdModalOverlay');

// ── Notifications Data ──
let notifications=[];
let notificationsLoaded=false;

// ── Logs Data (loaded from API) ──
let LOGS_DATA=[];

let currentUser={name:'Admin',email:'admin@codexfy.com',initials:'AD'};

// ── Auth ──
function showApp(){
  authScreen.classList.add('hidden');
  appEl.classList.remove('app-hidden');
  appEl.style.display='flex';
  updateUserUI();
  renderNotifications();
}
function showAuth(){
  authScreen.classList.remove('hidden');
  appEl.classList.add('app-hidden');
}

// Check session
(async function initAuth(){
  const token=localStorage.getItem('cx_token');
  const name=localStorage.getItem('cx_name');
  if(token && token !== 'null'){
    currentUser.name=name||'Admin';
    currentUser.email=localStorage.getItem('cx_email')||'admin@codexfy.com';
    currentUser.initials=(currentUser.name||'U').split(' ').map(w=>w[0]).join('').toUpperCase().slice(0,2);
    showApp();
  } else {
    // If coming from landing page with #register, show register form
    if(window.location.hash === '#register'){
      loginForm.classList.remove('active');
      regForm.classList.add('active');
    }
  }
})();

// ── LOGIN — uses backend API ──
loginForm.addEventListener('submit',async e=>{
  e.preventDefault();
  const btn=$('loginBtn'),err=$('loginError');
  const email=$('loginEmail').value.trim(),pass=$('loginPassword').value;
  btn.disabled=true;btn.querySelector('span').textContent='Entrando...';
  err.classList.remove('visible');
  try{
    if(!email||!pass) throw {message:'Preencha todos os campos'};

    const res = await authApi('POST', '/auth/login', { email, password: pass });

    // Save tokens
    localStorage.setItem('cx_token', res.access_token);
    localStorage.setItem('cg_token', res.access_token);
    if (res.refresh_token) localStorage.setItem('cg_refresh_token', res.refresh_token);

    // Decode JWT to get org_id
    try {
      const payload = JSON.parse(atob(res.access_token.split('.')[1]));
      if (payload.org_id) localStorage.setItem('cg_org_id', payload.org_id);
    } catch(_){}

    currentUser.name = email.split('@')[0];
    currentUser.email = email;
    currentUser.initials = currentUser.name.split(' ').map(w=>w[0]).join('').toUpperCase().slice(0,2);
    localStorage.setItem('cx_name', currentUser.name);
    localStorage.setItem('cx_email', currentUser.email);
    showApp();
  }catch(er){
    err.textContent = er.message || er.detail || 'E-mail ou senha incorretos';
    err.classList.add('visible');
  }
  btn.disabled=false;btn.querySelector('span').textContent='Entrar';
});

// ── REGISTER — uses backend API ──
regForm.addEventListener('submit',async e=>{
  e.preventDefault();
  const btn=$('regBtn'),err=$('regError');
  const name=$('regName').value.trim(),email=$('regEmail').value.trim(),pass=$('regPassword').value;
  btn.disabled=true;btn.querySelector('span').textContent='Criando...';
  err.classList.remove('visible');
  try{
    if(!name||!email||pass.length<6) throw {message:'Preencha todos os campos (senha min 6 caracteres)'};

    const res = await authApi('POST', '/auth/register', { name, email, password: pass });

    // Save tokens
    localStorage.setItem('cx_token', res.access_token);
    localStorage.setItem('cg_token', res.access_token);
    if (res.refresh_token) localStorage.setItem('cg_refresh_token', res.refresh_token);

    // Decode JWT to get org_id
    try {
      const payload = JSON.parse(atob(res.access_token.split('.')[1]));
      if (payload.org_id) localStorage.setItem('cg_org_id', payload.org_id);
    } catch(_){}

    currentUser.name = name;
    currentUser.email = email;
    currentUser.initials = name.split(' ').map(w=>w[0]).join('').toUpperCase().slice(0,2);
    localStorage.setItem('cx_name', currentUser.name);
    localStorage.setItem('cx_email', currentUser.email);
    showApp();
  }catch(er){
    err.textContent = er.message || er.detail || 'Erro ao criar conta';
    err.classList.add('visible');
  }
  btn.disabled=false;btn.querySelector('span').textContent='Criar conta';
});

$('showRegister').addEventListener('click',e=>{e.preventDefault();loginForm.classList.remove('active');regForm.classList.add('active');});
$('showLogin').addEventListener('click',e=>{e.preventDefault();regForm.classList.remove('active');loginForm.classList.add('active');});

// ── User Menu ──
function updateUserUI(){
  $('userInitials').textContent=currentUser.initials;
  $('userDropdownAvatar').textContent=currentUser.initials;
  $('userDropdownName').textContent=currentUser.name;
  $('userDropdownEmail').textContent=currentUser.email;
}
$('userAvatar').addEventListener('click',e=>{e.stopPropagation();userDropdown.classList.toggle('open');notifDropdown.classList.remove('open');});
$('btnLogout').addEventListener('click',()=>{
  localStorage.removeItem('cx_token');localStorage.removeItem('cx_name');localStorage.removeItem('cx_email');
  localStorage.removeItem('cg_token');localStorage.removeItem('cg_org_id');localStorage.removeItem('cg_refresh_token');
  showAuth();userDropdown.classList.remove('open');
});
$('btnProfile').addEventListener('click',()=>{userDropdown.classList.remove('open');document.querySelector('[data-page="settings"]').click();});
$('btnPrefs').addEventListener('click',()=>{userDropdown.classList.remove('open');document.querySelector('[data-page="settings"]').click();});

// ── Notifications ──
const NOTIF_ICONS = {
  analysis_completed: '<i data-lucide="search" style="width:16px;height:16px"></i>',
  mr_merged: '<i data-lucide="git-merge" style="width:16px;height:16px"></i>',
  mr_rejected: '<i data-lucide="x-circle" style="width:16px;height:16px"></i>',
  repo_added: '<i data-lucide="folder-plus" style="width:16px;height:16px"></i>',
  repo_synced: '<i data-lucide="refresh-cw" style="width:16px;height:16px"></i>',
  member_invited: '<i data-lucide="user-plus" style="width:16px;height:16px"></i>',
  rule_changed: '<i data-lucide="settings" style="width:16px;height:16px"></i>',
};
const NOTIF_TYPES = {
  analysis_completed: 'success',
  mr_merged: 'info',
  mr_rejected: 'danger',
  repo_added: 'info',
  repo_synced: 'info',
  member_invited: 'info',
  rule_changed: 'info',
};

function timeAgo(dateStr) {
  const d = new Date(dateStr), now = new Date(), ms = now - d;
  const min = Math.floor(ms/60000), h = Math.floor(min/60), day = Math.floor(h/24);
  if (min < 1) return 'agora';
  if (min < 60) return min + 'min atras';
  if (h < 24) return h + 'h atras';
  if (day === 1) return 'ontem';
  if (day < 30) return day + 'd atras';
  return new Date(dateStr).toLocaleDateString('pt-BR');
}

async function loadNotifications() {
  const token = localStorage.getItem('cg_token');
  const orgId = localStorage.getItem('cg_org_id');
  if (!token || !orgId) return;
  try {
    const r = await fetch(API_BASE + '/orgs/' + orgId + '/dashboard/activity?limit=15', {
      headers: { Authorization: 'Bearer ' + token }
    });
    if (!r.ok) return;
    const data = await r.json();
    notifications = (data || []).map((a, i) => ({
      id: a.id || i,
      text: a.description || a.event_type,
      type: NOTIF_TYPES[a.event_type] || 'info',
      icon: NOTIF_ICONS[a.event_type] || '📌',
      time: a.created_at,
      event_type: a.event_type,
      unread: i < 3,
    }));
    notificationsLoaded = true;
  } catch(_) {}
  renderNotifications();
}

function renderNotifications(){
  const list=$('notifList'),count=$('notifCount');
  const unread=notifications.filter(n=>n.unread).length;
  count.textContent=unread;count.style.display=unread?'flex':'none';
  if(!notifications.length){
    list.innerHTML=`
      <div class="notif-empty">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="opacity:0.4;margin-bottom:8px"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
        <div>Nenhuma notificação</div>
        <div style="font-size:0.78rem;margin-top:4px;opacity:0.6">Analise um MR para receber atualizações</div>
      </div>`;
    return;
  }
  list.innerHTML=notifications.map(n=>`
    <div class="notif-item ${n.unread?'unread':''}" data-nid="${n.id}">
      <div class="notif-icon-badge ${n.type}">${n.icon || '📌'}</div>
      <div class="notif-body">
        <div class="notif-text">${n.text}</div>
        <div class="notif-meta">
          <span class="notif-tag ${n.type}">${(n.event_type || n.type || '').replace(/_/g,' ')}</span>
          <span class="notif-time">${n.time ? timeAgo(n.time) : ''}</span>
        </div>
      </div>
    </div>`).join('');
  list.querySelectorAll('.notif-item').forEach(el=>el.addEventListener('click',()=>{
    const n=notifications.find(x=>String(x.id)===el.dataset.nid);if(n)n.unread=false;renderNotifications();
  }));
}
$('notifBtn').addEventListener('click',e=>{
  e.stopPropagation();
  notifDropdown.classList.toggle('open');
  userDropdown.classList.remove('open');
  if (!notificationsLoaded) loadNotifications();
});
$('clearNotifs').addEventListener('click',()=>{notifications.forEach(n=>n.unread=false);renderNotifications();});
document.addEventListener('click',()=>{notifDropdown.classList.remove('open');userDropdown.classList.remove('open');});
$('notifDropdown').addEventListener('click',e=>e.stopPropagation());
$('userDropdown').addEventListener('click',e=>e.stopPropagation());

// ── Theme ──
const savedTheme=localStorage.getItem('cx_theme')||'dark';
document.documentElement.setAttribute('data-theme',savedTheme);
$('themeToggle').addEventListener('click',()=>{
  const cur=document.documentElement.getAttribute('data-theme');
  const next=cur==='dark'?'light':'dark';
  document.documentElement.setAttribute('data-theme',next);
  localStorage.setItem('cx_theme',next);
});

// ── Keyboard Shortcuts ──
$('kbdModalClose').addEventListener('click',()=>kbdOverlay.classList.remove('active'));
kbdOverlay.addEventListener('click',e=>{if(e.target===kbdOverlay)kbdOverlay.classList.remove('active');});
document.addEventListener('keydown',e=>{
  if(e.ctrlKey&&e.key==='k'){e.preventDefault();$('searchInput').focus();}
  if(e.ctrlKey&&e.key==='/'){e.preventDefault();kbdOverlay.classList.add('active');}
  if(e.ctrlKey&&e.key==='d'){e.preventDefault();$('themeToggle').click();}
  if(e.ctrlKey&&e.key==='1'){e.preventDefault();document.querySelector('[data-page="dashboard"]').click();}
  if(e.ctrlKey&&e.key==='2'){e.preventDefault();document.querySelector('[data-page="merge-requests"]').click();}
});

// ── Expose for app.js ──
window.CodexfyLogs=LOGS_DATA;
window.CodexfyUser=currentUser;
})();
