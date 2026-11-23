import { api, initCsrf } from './api.js';
import { connect } from './socket.js';
import { observeVisible } from './visibility.js';

// Session and conversation state stays in memory for the lifetime of this page.
const $ = (id) => document.getElementById(id);
let me;
let rooms = [];
let room;
let socket;
let socketGeneration = 0;
let connected = false;
let synced = false;
let online = [];
let messages = new Map();
let pending = new Map();
let seen = new Set();
let delivered = new Set();
let revision = 0;
let generation = 0;
let serverBase = Date.now();
let monoBase = performance.now();
let serverTimeKnown = false;
let lastTyping = 0;
let syncing = false;
let dirty = false;
let loadingRoom = false;
const drafts = new Map();
const invitations = new Map();
const copiedInvitations = new Map();
const unreadRooms = new Set();
let listVersion = 0;
let creating = false;
let entryReady = false;
let editingName = false;
let previewReady = false;
let requestedRoom;
let receiptMessageId;
const initialChat = location.hash.startsWith('#chat=') ? location.hash.slice(6) : null;
let joinSecret = location.hash.startsWith('#invite=') ? location.hash.slice(8) : null;
// Remove the invitation from the address bar once it has been captured for joining.
if (joinSecret) {
    history.replaceState(null, '', location.pathname);
}

// Keep drafts and uncertain sends in memory only; clear their text when the room ends.
function clearPending(roomId) {
    for (const [id, item] of pending) {
        if (roomId && item.roomId !== roomId) continue;
        clearTimeout(item.timer);
        item.body = '';
        pending.delete(id);
    }
}

function forgetRoom(roomId) {
    drafts.delete(roomId);
    clearPending(roomId);
    if (room?.id === roomId) {
        $('draft').value = '';
        $('draft').style.height = 'auto';
    }
}

function rememberDraft() {
    if (!room || !['active', 'waiting'].includes(room.state)) return;
    const body = $('draft').value;
    if (body) drafts.set(room.id, body);
    else drafts.delete(room.id);
}

function acceptPending(id) {
    const item = pending.get(id);
    if (item) {
        clearTimeout(item.timer);
        item.body = '';
    }
    pending.delete(id);
}

// Anchor countdowns to server time and a monotonic clock to avoid local clock changes.
const now = () => serverBase + performance.now() - monoBase;
function toast(text) {
    $('toast').textContent = text;
    $('toast').hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => ($('toast').hidden = true), 5000);
}

function fail(e) {
    toast(e.message);
    if (e.status === 401) {
        expireSession();
    }
}

function expireSession() {
    $('chat-actions').hidePopover();
    $('chat-details').hidePopover();
    socketGeneration++;
    socket?.close();
    socket = null;
    connected = synced = false;
    loadingRoom = false;
    serverTimeKnown = false;
    generation++;
    listVersion++;
    requestedRoom = null;
    messages.clear();
    clearPending();
    drafts.clear();
    $('draft').value = '';
    $('messages').replaceChildren();
    $('rooms').replaceChildren();
    $('room-expiry').hidden = true;
    $('shell').hidden = true;
    $('welcome').hidden = false;
    $('invite-dialog').close();
    $('members-dialog').close();
    $('receipts-dialog').close();
    $('logout-dialog').close();
    $('create-dialog').close();
    $('end-dialog').close();
    receiptMessageId = null;
    $('invite-link').value = '';
    $('group-invite-link').value = '';
    invitations.clear();
    copiedInvitations.clear();
    unreadRooms.clear();
    me = null;
    $('name').value = '';
    room = null;
    rooms = [];
    history.replaceState(null, '', location.pathname);
    editingName = false;
    entryReady = true;
    controls();
    configureEntry();
}

function controls() {
    const ready =
        navigator.onLine && connected && synced && !loadingRoom && room?.state === 'active';
    const n = Array.from($('draft').value).length;
    $('draft').disabled = loadingRoom || room?.state !== 'active';
    $('send').disabled = !ready || !$('draft').value.trim() || n > 2000;
    $('count').textContent = n > 1800 ? `${2000 - n}` : '';
    $('connection').textContent = !navigator.onLine
        ? 'Offline'
        : connected
          ? synced
              ? 'Connected · up to date'
              : 'Syncing…'
          : navigator.onLine
            ? 'Reconnecting…'
            : 'Offline';
    $('connection').classList.toggle('ready', navigator.onLine && connected && synced);
    $('connection-banner').hidden = connected && navigator.onLine;
    $('connection-banner').textContent = navigator.onLine
        ? 'Reconnecting… Your draft stays on this page.'
        : 'You’re offline. Reconnect to continue. Your draft stays on this page.';
    $('chat-loading').hidden = !loadingRoom;
    $('messages').setAttribute('aria-busy', String(loadingRoom));
    if (room) {
        $('messages').hidden = loadingRoom || room.state === 'waiting';
        $('waiting').hidden = loadingRoom || room.state !== 'waiting';
        $('composer').hidden = loadingRoom || room.state !== 'active';
        $('composer-help').hidden = loadingRoom || room.state !== 'active';
        $('typing').hidden = loadingRoom || room.state !== 'active';
    } else {
        $('room-title').textContent = 'Your next conversation';
        $('presence').textContent = 'Choose a chat or invite your friends.';
        $('peer-avatar').textContent = '✳';
        $('messages').hidden = false;
        for (const id of [
            'waiting',
            'composer',
            'composer-help',
            'typing',
            'policy',
            'members-button',
            'invite-friends',
            'chat-options',
            'room-expiry',
        ])
            $(id).hidden = true;
        $('typing').textContent = '';
    }
}

function chatCode(r) {
    return r.code || r.id.slice(0, 6).toUpperCase();
}

function peerOf(r) {
    return r.participants?.find((p) => p.id !== me?.id);
}

function chatLabel(r) {
    return (
        r.title ||
        ((r.participants?.length || 0) > 2
            ? `Group chat ${chatCode(r)}`
            : peerOf(r)
              ? `Chat with ${peerOf(r).displayName}`
              : `Chat ${chatCode(r)}`)
    );
}

// Conversation list and header rendering.
function renderRooms() {
    const focused = document.activeElement?.dataset.roomId;
    const activeRooms = rooms.filter((item) => ['active', 'waiting'].includes(item.state));
    $('room-count').textContent = activeRooms.length;
    $('chat-list-help').hidden = activeRooms.length > 0;
    $('rooms').replaceChildren();
    if (!activeRooms.length) {
        const note = document.createElement('p');
        note.className = 'room-list-empty';
        note.textContent = 'No chats yet. Start one and invite your friend.';
        $('rooms').append(note);
    }
    for (const state of ['active', 'waiting']) {
        const group = activeRooms.filter((r) => r.state === state);
        if (!group.length) {
            continue;
        }
        const heading = document.createElement('div');
        heading.className = 'room-group-label';
        heading.textContent = state === 'active' ? 'CHATTING' : 'WAITING FOR A FRIEND';
        $('rooms').append(heading);
        for (const r of group) {
            const selected = r.id === room?.id;
            const peer = peerOf(r);
            const b = document.createElement('button');
            b.className = 'room-item' + (selected ? ' selected' : '');
            b.dataset.roomId = r.id;
            if (selected) {
                b.setAttribute('aria-current', 'true');
            }
            const avatar = document.createElement('span');
            avatar.className = 'avatar';
            avatar.textContent = peer?.displayName.slice(0, 1).toUpperCase() || '＋';
            const info = document.createElement('span');
            info.className = 'room-info';
            const name = document.createElement('strong');
            name.textContent = chatLabel(r);
            const status = document.createElement('small');
            status.textContent =
                r.participants.length > 2
                    ? `${r.participants.length} members`
                    : peer
                      ? `With ${peer.displayName}`
                      : 'Share an invitation to start';
            info.append(name, status);
            b.append(avatar, info);
            if (unreadRooms.has(r.id)) {
                const badge = document.createElement('span');
                badge.className = 'room-badge';
                badge.textContent = 'New message';
                b.append(badge);
                b.setAttribute('aria-label', `${chatLabel(r)}, new message`);
            }
            b.onclick = () => open(r.id);
            $('rooms').append(b);
        }
    }
    if (focused) {
        [...$('rooms').querySelectorAll('[data-room-id]')]
            .find((b) => b.dataset.roomId === focused)
            ?.focus();
    }
}

async function list() {
    const version = ++listVersion;
    const result = await api('/rooms');
    if (version !== listVersion) {
        return;
    }
    rooms = result;
    const activeIds = new Set(rooms.map((item) => item.id));
    for (const id of new Set([
        ...drafts.keys(),
        ...[...pending.values()].map((item) => item.roomId),
    ])) {
        if (!activeIds.has(id)) forgetRoom(id);
    }
    renderRooms();
}

function head() {
    if (!room) {
        return;
    }
    const peer = peerOf(room);
    const ended = ['closed', 'expired'].includes(room.state);
    $('room-title').textContent = chatLabel(room);
    $('chat-code').textContent = `Chat ${chatCode(room)}`;
    $('peer-avatar').textContent = peer?.displayName.slice(0, 1).toUpperCase() || '✳';
    $('presence').textContent = ended
        ? 'This chat has ended'
        : room.participants.length > 2
          ? `${room.participants.length} members · ${online.length} online`
          : peer
            ? `With ${peer.displayName} · ${online.includes(peer.id) ? 'Online' : 'Offline'}`
            : 'Share the invitation to bring your friends here';
    $('end').hidden = !['active', 'waiting'].includes(room.state);
    $('chat-options').hidden = false;
    $('policy').hidden = false;
    $('invite-friends').hidden = ended || room.state !== 'active' || room.creatorId !== me.id;
    $('members-button').hidden = ended;
    $('members-button').textContent = `Members (${room.participants.length})`;
    if (ended) {
        $('invite-dialog').close();
        $('members-dialog').close();
    }
    const ttl =
        room.ttlSeconds < 3600 ? `${room.ttlSeconds / 60} min` : `${room.ttlSeconds / 3600} hr`;
    $('policy').textContent = `◷ Disappears ${room.readGraceSeconds}s after everyone views`;
    $('detail-grace').textContent = `Disappears after ${room.readGraceSeconds} seconds`;
    $('detail-ttl').textContent = `Available for up to ${ttl}`;
    $('detail-end').textContent = new Date(room.expiresAt).toLocaleString([], {
        dateStyle: 'medium',
        timeStyle: 'short',
    });
    $('waiting').hidden = room.state !== 'waiting';
    $('messages').hidden = room.state === 'waiting';
    $('composer').hidden = room.state !== 'active';
    $('typing').hidden = room.state !== 'active';
    $('composer-help').hidden = room.state !== 'active';
    $('draft').placeholder =
        room.participants.length > 2
            ? 'Message the group…'
            : peer
              ? `Message ${peer.displayName}…`
              : 'Type your message…';
    $('waiting-title').textContent = 'Waiting for your friends';
    $('waiting-chat-name').textContent = chatLabel(room);
    $('waiting-code').textContent = `One link · Up to ${room.maxParticipants} people`;
    $('invite-label').textContent = `Invitation for ${chatLabel(room)}`;
    $('end-title').textContent = `End “${chatLabel(room)}”?`;
    if (ended) {
        invitations.delete(room.id);
    }
    $('group-invite-title').textContent = `Invite friends to ${chatLabel(room)}`;
    renderMembers();
    const index = rooms.findIndex((r) => r.id === room.id);
    if (index >= 0) {
        rooms[index] = room;
    }
    renderRooms();
    showInvite();
    updateRoomWarning();
    controls();
}

function senderColor(id) {
    const hash = Array.from(id).reduce(
        (value, character) => (value * 31 + character.codePointAt(0)) | 0,
        0,
    );
    return `sender-color-${Math.abs(hash) % 6}`;
}

function updateTimer(element) {
    const seconds = Math.max(0, Math.ceil((Date.parse(element.dataset.deadline) - now()) / 1000));
    element.textContent =
        seconds <= 10 ? `◷ ${seconds}s left` : `◷ ${remaining(element.dataset.deadline)}`;
    element.classList.toggle('expiring', seconds <= 10);
    element.setAttribute('aria-label', `Message disappears in ${seconds} seconds`);
}

// Delivery means received; seen requires the visibility observer to confirm a view.
let visibility = observeVisible($('messages'), (id) => {
    const m = messages.get(id);
    if (!m || seen.has(id) || m.senderId === me?.id || !synced || !connected) {
        return;
    }
    seen.add(id);
    socket.send('seen', { roomId: room.id, messageId: id });
});
function render() {
    visibility.clear();
    const area = $('messages');
    // Keep the first visible message in place while receipts and timers update the list.
    const anchor = [...area.querySelectorAll('[data-id]')].find(
        (el) => el.getBoundingClientRect().bottom > area.getBoundingClientRect().top,
    );
    const anchorId = anchor?.dataset.id;
    const anchorTop = anchor?.getBoundingClientRect().top;
    const near = area.scrollHeight - area.scrollTop - area.clientHeight < 100;
    const previous = area.scrollTop;
    const oldHeight = area.scrollHeight;
    area.replaceChildren();
    if (!room) {
        const box = document.createElement('div');
        box.className = 'empty';
        const title = document.createElement('h2');
        title.textContent = 'Your next conversation starts here.';
        const description = document.createElement('p');
        description.textContent = 'Create a chat and share its invitation with your friends.';
        const create = document.createElement('button');
        create.id = 'empty-create';
        create.className = 'primary';
        create.textContent = 'Create a chat';
        create.onclick = showCreate;
        box.append(title, description, create);
        area.append(box);
        return;
    }
    const current = [...messages.values()]
        .filter((m) => m.body && Date.parse(m.disappearsAt) > now())
        .sort((a, b) => a.sequence - b.sequence);
    const roomPending = [...pending].filter(([, item]) => item.roomId === room.id);
    if (!current.length && !roomPending.length) {
        const box = document.createElement('div');
        box.className = 'empty';
        const h = document.createElement('h2');
        h.textContent = ['closed', 'expired'].includes(room.state)
            ? 'This moment has passed.'
            : 'The conversation starts here.';
        const p = document.createElement('p');
        p.textContent = ['closed', 'expired'].includes(room.state)
            ? 'Message content is gone. Start a new room whenever you like.'
            : 'Send a thought. It doesn’t have to stay forever.';
        box.append(h, p);
        area.append(box);
    }
    let previousMessage;
    for (const m of current) {
        const row = document.createElement('div');
        row.className = 'bubble-row' + (m.senderId === me.id ? ' own' : '');
        row.dataset.id = m.id;
        const grouped =
            previousMessage?.senderId === m.senderId &&
            Date.parse(m.acceptedAt) - Date.parse(previousMessage.acceptedAt) < 120000;
        row.classList.toggle('grouped', grouped);
        const content = document.createElement('div');
        content.className = 'message-content';
        const body = document.createElement('div');
        body.className = 'bubble';
        // Treat message content as plain text, including any HTML-like characters.
        body.textContent = m.body;
        const meta = document.createElement('div');
        meta.className = 'meta';
        const status = document.createElement(m.senderId === me.id ? 'button' : 'span');
        if (m.senderId === me.id) {
            status.className = 'receipt-button';
            status.setAttribute('aria-label', `View receipt details: ${receiptLabel(m)}`);
            status.onclick = () => {
                receiptMessageId = m.id;
                renderReceiptDetails();
                $('receipts-dialog').showModal();
            };
        }
        status.textContent =
            m.senderId === me.id
                ? receiptLabel(m)
                : new Date(m.acceptedAt).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                  });
        meta.append(status);
        const timer = document.createElement('span');
        timer.dataset.deadline = m.disappearsAt;
        timer.className = 'message-timer';
        updateTimer(timer);
        meta.append(timer);
        if (m.senderId !== me.id && room.participants.length > 2) {
            const name =
                room.participants.find((p) => p.id === m.senderId)?.displayName || 'Group member';
            const avatar = document.createElement('span');
            avatar.className = `sender-avatar ${senderColor(m.senderId)}`;
            avatar.textContent = name.slice(0, 1).toUpperCase();
            avatar.setAttribute('aria-hidden', 'true');
            row.append(avatar);
            row.classList.add('group-message');
            if (!grouped) {
                const author = document.createElement('span');
                author.className = `message-author ${senderColor(m.senderId)}`;
                author.textContent = name;
                content.append(author);
            }
        }
        content.append(body, meta);
        row.append(content);
        previousMessage = m;
        area.append(row);
        if (m.senderId !== me.id && !(m.seenGuestIds || []).includes(me.id)) {
            visibility.watch(row);
        }
        if (m.senderId !== me.id && !delivered.has(m.id) && connected) {
            delivered.add(m.id);
            socket.send('delivered', { roomId: room.id, messageId: m.id });
        }
    }
    for (const [id, p] of roomPending) {
        const row = document.createElement('div');
        row.className = 'bubble-row own';
        const body = document.createElement('div');
        body.className = 'bubble';
        body.textContent = p.body;
        const meta = document.createElement('div');
        meta.className = 'meta';
        meta.textContent =
            p.state === 'sending'
                ? 'Sending…'
                : p.state === 'unconfirmed'
                  ? 'Not confirmed · server has no record of this send'
                  : 'Checking whether this was sent…';
        if (p.state === 'unconfirmed' || p.checkFailed) {
            const retry = document.createElement('button');
            retry.textContent = p.verified ? 'Retry' : 'Check status';
            retry.disabled = !connected || !synced || !navigator.onLine;
            retry.onclick = () => (p.verified ? retrySend(id) : verifyPending(id));
            meta.append(retry);
        }
        const content = document.createElement('div');
        content.className = 'message-content';
        content.append(body, meta);
        row.append(content);
        area.append(row);
    }
    if (near) {
        area.scrollTop = area.scrollHeight;
    } else {
        const restored = [...area.querySelectorAll('[data-id]')].find(
            (el) => el.dataset.id === anchorId,
        );
        if (restored) {
            area.scrollTop += restored.getBoundingClientRect().top - anchorTop;
        } else {
            area.scrollTop =
                previous + (area.scrollHeight < oldHeight ? area.scrollHeight - oldHeight : 0);
        }
        $('new-messages').hidden = false;
    }
    renderReceiptDetails();
}

function remaining(deadline) {
    const s = Math.max(0, Math.ceil((Date.parse(deadline) - now()) / 1000));
    return s < 60 ? `${s}s` : s < 3600 ? `${Math.ceil(s / 60)}m` : `${Math.ceil(s / 3600)}h`;
}

// Invalidate old snapshots before switching chats so late responses cannot mix messages.
async function open(id) {
    if (room?.id === id) {
        $('shell').classList.add('chat-open');
        head();
        if (!synced) {
            await reconcile();
        }
        return;
    }
    if (room?.state === 'active' && connected) {
        try {
            socket.send('typing', { roomId: room.id, typing: false });
        } catch {}
    }
    rememberDraft();
    $('receipts-dialog').close();
    receiptMessageId = null;
    $('chat-actions').hidePopover();
    $('chat-details').hidePopover();
    generation++;
    room = rooms.find((r) => r.id === id) || { id, participants: [] };
    messages.clear();
    seen.clear();
    delivered.clear();
    unreadRooms.delete(id);
    $('draft').value = drafts.get(id) || '';
    $('draft').style.height = 'auto';
    $('typing').textContent = '';
    $('invite-link').value = '';
    $('copy').disabled = false;
    $('regenerate').disabled = false;
    $('group-copy').disabled = false;
    $('group-regenerate').disabled = false;
    $('new-messages').hidden = true;
    $('shell').classList.add('chat-open');
    synced = false;
    loadingRoom = true;
    history.replaceState(null, '', `${location.pathname}#chat=${encodeURIComponent(id)}`);
    head();
    render();
    await reconcile();
    await list();
}

// Fetch all pages at one revision; retry if the conversation changes during pagination.
async function reconcile() {
    if (!room || !connected) {
        return;
    }
    if (syncing) {
        dirty = true;
        return;
    }
    syncing = true;
    synced = false;
    controls();
    const id = room.id;
    const gen = generation;
    try {
        let snapshot = await api('/rooms/' + id);
        let all = [...snapshot.messages];
        let cursor = snapshot.nextCursor;
        while (cursor !== null) {
            const page = await api(
                `/rooms/${id}/messages?after=${cursor}&revision=${snapshot.revision}`,
            );
            all.push(...page.messages);
            cursor = page.nextCursor;
        }
        if (gen !== generation) {
            return;
        }
        serverTimeKnown = true;
        serverBase = Date.parse(snapshot.serverTime);
        monoBase = performance.now();
        room = snapshot.room;
        revision = snapshot.revision;
        online = snapshot.online;
        messages = new Map(
            all.filter((m) => Date.parse(m.disappearsAt) > now()).map((m) => [m.id, m]),
        );
        for (const m of all) {
            acceptPending(m.operationId);
        }
        if (room.state === 'closed' || room.state === 'expired') {
            forgetRoom(room.id);
        }
        synced = true;
        recoverPending(id);
        head();
        render();
    } catch (e) {
        if (gen !== generation) return;
        if (e.category === 'resynchronize') {
            dirty = true;
        } else {
            if (e.status === 404 || e.status === 410) {
                messages.clear();
                forgetRoom(room.id);
                room.state = 'closed';
                head();
                render();
            }
            fail(e);
        }
    } finally {
        syncing = false;
        if (gen === generation) loadingRoom = false;
        controls();
        if (dirty) {
            dirty = false;
            setTimeout(() => reconcile(), 100);
        }
    }
}

// Apply ordered events when possible; recover revision gaps with a fresh snapshot.
function event(e) {
    if (e.type === 'message.accepted') acceptPending(e.data.operationId);
    if (e.roomId !== room?.id) {
        if (
            (e.type === 'message.accepted' || e.type === 'message.available') &&
            e.data.senderId !== me?.id &&
            e.data.available &&
            Date.parse(e.data.disappearsAt) > now()
        ) {
            unreadRooms.add(e.roomId);
            renderRooms();
            if (connected) {
                socket.send('delivered', { roomId: e.roomId, messageId: e.data.id });
            }
        }
        if (e.type === 'room.updated' || e.type === 'room.closed') {
            if (e.type === 'room.closed') {
                forgetRoom(e.roomId);
                invitations.delete(e.roomId);
                unreadRooms.delete(e.roomId);
            }
            list().catch(fail);
        }
        return;
    }
    if (e.type === 'presence.changed') {
        online = e.data.online;
        head();
        return;
    }
    if (e.type === 'typing.changed') {
        const names = e.data.guests
            .filter((g) => g !== me.id)
            .map((g) => room.participants.find((p) => p.id === g)?.displayName || 'Someone');
        $('typing').textContent =
            names.length > 2
                ? `${names.length} people are typing…`
                : names.length
                  ? `${names.join(' and ')} ${names.length === 1 ? 'is' : 'are'} typing…`
                  : '';
        return;
    }
    if (e.serverTime) {
        serverBase = Date.parse(e.serverTime);
        monoBase = performance.now();
    }
    if (e.type === 'message.accepted') {
        acceptPending(e.data.operationId);
    }
    if (syncing) {
        dirty = true;
        return;
    }
    if (e.revision < revision) {
        return;
    }
    if (e.type === 'room.closed') {
        messages.clear();
        forgetRoom(room.id);
        room.state = 'closed';
        $('typing').textContent = '';
        head();
        render();
    }
    if (e.revision > revision + 1 || e.type === 'room.updated') {
        reconcile();
        list().catch(fail);
        return;
    }
    revision = Math.max(revision, e.revision);
    if (e.type === 'message.accepted' || e.type === 'message.available') {
        const m = e.data;
        if (m.body && Date.parse(m.disappearsAt) > now()) {
            messages.set(m.id, m);
        } else {
            messages.delete(m.id);
        }
    } else if (e.type === 'message.removed') {
        messages.delete(e.data.id);
    } else if (e.type === 'message.seen' || e.type === 'message.delivered') {
        const m = messages.get(e.data.id);
        if (m) {
            messages.set(m.id, { ...m, ...e.data });
        }
    }
    render();
}

// Start the socket after identity and CSRF initialization, then restore the selected chat.
async function begin() {
    me = await api('/me');
    const session = ++socketGeneration;
    if (socket) {
        markPendingUncertain();
        socket.close();
    }
    connected = synced = false;
    $('welcome').hidden = true;
    $('shell').hidden = false;
    $('guest-name').textContent = me.displayName;
    $('initial').textContent = me.displayName.slice(0, 1).toUpperCase();
    const csrf = await initCsrf();
    socket = connect(
        csrf,
        (incoming) => {
            if (session === socketGeneration) event(incoming);
        },
        async (ok) => {
            if (session !== socketGeneration) return;
            connected = ok;
            synced = false;
            controls();
            if (!ok) {
                markPendingUncertain();
                render();
                return;
            }
            try {
                await list();
                if (session !== socketGeneration) return;
                recoverPending();
                if (requestedRoom) {
                    const id = requestedRoom;
                    requestedRoom = null;
                    await open(id);
                } else if (room) {
                    history.replaceState(
                        null,
                        '',
                        `${location.pathname}#chat=${encodeURIComponent(room.id)}`,
                    );
                    await reconcile();
                } else if (creating) {
                    return;
                } else if (initialChat && rooms.some((r) => r.id === initialChat)) {
                    await open(initialChat);
                } else if (rooms.length === 1) {
                    await open(rooms[0].id);
                } else {
                    synced = true;
                    controls();
                    render();
                }
            } catch (e) {
                fail(e);
            }
        },
        (e) => {
            if (session !== socketGeneration) return;
            markPendingUncertain();
            recoverPending();
            toast(e.message);
            reconcile();
            render();
        },
    );
}
function lifetimeLabel(seconds) {
    return seconds < 3600 ? `${seconds / 60} min` : `${seconds / 3600} hr`;
}

function configureEntry() {
    const returning = Boolean(me && joinSecret);
    $('entry-title').textContent = joinSecret
        ? 'You’re invited. Join the moment.'
        : 'Make room for a conversation.';
    $('entry-copy').textContent = joinSecret
        ? 'Review this chat, then choose whether to join. Opening the link does not add you.'
        : 'Choose your name, create one chat, and send the same invitation to all your friends.';
    $('name-fields').hidden = returning && !editingName;
    $('name').required = !returning || editingName;
    $('returning-guest').hidden = !returning;
    $('returning-guest').textContent = returning ? `You’re joining as ${me.displayName}.` : '';
    $('change-name').hidden = !returning || editingName;
    $('enter').textContent =
        returning && !editingName
            ? `Join as ${me.displayName}`
            : joinSecret
              ? 'Join chat'
              : 'Continue';
    $('enter').disabled = !entryReady || Boolean(joinSecret && !previewReady);
    $('join-preview').hidden = !joinSecret;
    $('skip-invite').hidden = !joinSecret;
}

async function loadInvitationPreview() {
    const secret = joinSecret;
    if (!secret) return;
    previewReady = false;
    $('preview-title').textContent = 'Loading invitation…';
    $('preview-people').textContent = '';
    $('preview-policy').textContent = '';
    $('preview-error').hidden = true;
    $('retry-preview').hidden = true;
    configureEntry();
    try {
        // Keep the bearer secret out of URLs, browser history, and referrer headers.
        const preview = await api('/invites/preview', 'POST', { secret });
        if (secret !== joinSecret) return;
        $('preview-title').textContent = preview.title;
        $('preview-people').textContent =
            `${preview.participantCount} of ${preview.maxParticipants} people · Room ends ${new Date(preview.roomExpiresAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}`;
        $('preview-policy').textContent =
            `Messages disappear ${preview.readGraceSeconds}s after every original recipient views them, or after ${lifetimeLabel(preview.ttlSeconds)} unread. You won’t see messages sent before you join.`;
        previewReady = true;
    } catch (error) {
        if (secret !== joinSecret) return;
        $('preview-title').textContent = 'Invitation unavailable';
        $('preview-error').textContent = error.message;
        $('preview-error').hidden = false;
        $('retry-preview').hidden = false;
    }
    configureEntry();
}

$('change-name').onclick = () => {
    editingName = true;
    $('name').value = me.displayName;
    configureEntry();
    $('name').focus();
};
$('retry-preview').onclick = loadInvitationPreview;
$('skip-invite').onclick = async () => {
    joinSecret = null;
    editingName = false;
    configureEntry();
    if (me) {
        try {
            await begin();
        } catch (error) {
            fail(error);
        }
    }
};
$('entry-form').onsubmit = async (event) => {
    event.preventDefault();
    if (!entryReady || (joinSecret && !previewReady)) return;
    entryReady = false;
    configureEntry();
    try {
        if (!me) me = await api('/guests', 'POST', { displayName: $('name').value });
        else if (editingName) me = await api('/me', 'PATCH', { displayName: $('name').value });
        if (joinSecret) {
            const joined = await api('/invites/redeem', 'POST', { secret: joinSecret });
            requestedRoom = joined.id;
            joinSecret = null;
        }
        await begin();
    } catch (error) {
        fail(error);
        if (joinSecret && error.category === 'invite_unavailable') await loadInvitationPreview();
    } finally {
        entryReady = true;
        configureEntry();
    }
};

// Chat creation and invitation actions.
function showCreate() {
    $('fresh-start-note').hidden = true;
    const waiting = rooms.find((r) => r.state === 'waiting');
    $('resume-waiting').hidden = !waiting;
    if (waiting) {
        $('resume-waiting').textContent = `Open your waiting chat: ${chatLabel(waiting)}`;
        $('resume-waiting').onclick = () => {
            $('create-dialog').close();
            open(waiting.id).catch(fail);
        };
    }
    $('create-submit').textContent = waiting ? 'Create a separate chat' : 'Create chat';
    $('create-dialog').showModal();
}
$('new-room').onclick = showCreate;
$('empty-create').onclick = showCreate;
$('cancel-create').onclick = () => $('create-dialog').close();
$('create-form').onsubmit = async (e) => {
    e.preventDefault();
    if (creating) {
        return;
    }
    creating = true;
    $('create-submit').disabled = true;
    try {
        const created = await api('/rooms', 'POST', {
            ttlSeconds: Number($('ttl').value),
            title: $('chat-name').value,
        });
        invitations.set(created.room.id, created.invite);
        $('create-dialog').close();
        $('chat-name').value = '';
        await list();
        await open(created.room.id);
    } catch (e) {
        fail(e);
    } finally {
        creating = false;
        $('create-submit').disabled = false;
    }
};
function receiptLabel(message) {
    const total = message.recipientCount || 1;
    const views = message.seenCount || 0;
    const deliveries = message.deliveredCount || 0;
    if (total === 1) {
        return views ? 'Seen' : deliveries ? 'Delivered' : 'Sent';
    }
    return views
        ? `Seen by ${views}/${total}`
        : deliveries
          ? `Delivered to ${deliveries}/${total}`
          : 'Sent';
}

function renderReceiptDetails() {
    if (!receiptMessageId) return;
    const message = messages.get(receiptMessageId);
    if (!message || Date.parse(message.disappearsAt) <= now()) {
        $('receipts-dialog').close();
        receiptMessageId = null;
        $('receipts-list').replaceChildren();
        return;
    }
    const recipients = message.recipientIds || [];
    $('receipts-list').replaceChildren();
    for (const id of recipients) {
        const member = room.participants.find((person) => person.id === id);
        const row = document.createElement('li');
        const name = document.createElement('strong');
        const state = document.createElement('span');
        name.textContent = member?.displayName || 'Guest';
        const duplicates =
            room.participants.filter((person) => person.displayName === member?.displayName)
                .length > 1;
        if (duplicates) name.textContent += ` · ${id.slice(0, 6).toUpperCase()}`;
        state.textContent = (message.seenGuestIds || []).includes(id)
            ? 'Viewed'
            : (message.deliveredGuestIds || []).includes(id)
              ? 'Delivered · not viewed'
              : 'Not delivered yet';
        row.append(name, state);
        $('receipts-list').append(row);
    }
    $('receipts-description').textContent = message.seenAt
        ? 'Everyone this message was sent to has viewed it. The short countdown has started; it may end sooner when the room closes.'
        : `The ${room.readGraceSeconds}s countdown starts after all ${recipients.length} original ${recipients.length === 1 ? 'recipient has' : 'recipients have'} viewed this message. Until then, its unread timer applies. Later members do not join this message’s audience.`;
}
$('close-receipts').onclick = () => $('receipts-dialog').close();
$('receipts-dialog').addEventListener('close', () => {
    receiptMessageId = null;
    $('receipts-list').replaceChildren();
});

function updateRoomWarning() {
    if (!room) {
        $('room-expiry').hidden = true;
        return;
    }
    const left = Date.parse(room.expiresAt) - now();
    const ended = ['closed', 'expired'].includes(room.state) || left <= 0;
    $('room-expiry').hidden = !ended && left > 300000;
    const text = ended
        ? 'This room has ended.'
        : `This room ends in ${Math.max(1, Math.ceil(left / 60000))} min.`;
    // Update only when the minute changes, avoiding repeated live-region announcements.
    if ($('room-expiry-text').textContent !== text) $('room-expiry-text').textContent = text;
}
$('fresh-chat').onclick = () => {
    showCreate();
    $('fresh-start-note').hidden = false;
    $('chat-name').value = room?.title || '';
    if (room) $('ttl').value = String(room.ttlSeconds);
};

function renderMembers() {
    $('members-list').replaceChildren();
    for (const member of room?.participants || []) {
        const row = document.createElement('li');
        const name = document.createElement('strong');
        const state = document.createElement('span');
        name.textContent = member.displayName + (member.id === me.id ? ' (you)' : '');
        state.textContent =
            (member.id === room.creatorId ? 'Creator · ' : '') +
            (online.includes(member.id) ? 'Online' : 'Offline');
        const avatar = document.createElement('span');
        avatar.className = `sender-avatar ${senderColor(member.id)}`;
        avatar.textContent = member.displayName.slice(0, 1).toUpperCase();
        avatar.setAttribute('aria-hidden', 'true');
        row.append(avatar, name, state);
        $('members-list').append(row);
    }
    $('members-description').textContent =
        `${room?.participants.length || 0} of ${room?.maxParticipants || 20} people. New members see messages sent after they join.`;
}

function showInvite() {
    if (!room || !['waiting', 'active'].includes(room.state)) {
        return;
    }
    const invitation = invitations.get(room.id);
    const available = invitation && Date.parse(invitation.expiresAt) > now();
    for (const prefix of ['', 'group-']) {
        $(prefix + 'invite-link').value = available
            ? location.origin + '/#invite=' + invitation.secret
            : '';
        $(prefix + 'invite-link').hidden = !available;
        $(prefix + 'invite-label').hidden = !available;
        const copied = (copiedInvitations.get(room.id + prefix) || 0) > performance.now();
        $(prefix + 'copy').textContent = copied
            ? '✓ Copied!'
            : available
              ? 'Copy invite link'
              : 'Create invitation';
        $(prefix + 'regenerate').hidden = !available;
        $(prefix + 'invite-expiry').textContent = available
            ? 'Everyone can reuse this link · expires in ' + remaining(invitation.expiresAt)
            : 'Create one invitation and share it with all your friends.';
    }
}

async function generateInvite() {
    if (!room || !['waiting', 'active'].includes(room.state) || room.creatorId !== me.id) {
        return;
    }
    const id = room.id;
    copiedInvitations.delete(id);
    copiedInvitations.delete(id + 'group-');
    for (const prefix of ['', 'group-']) {
        $(prefix + 'copy').disabled = true;
        $(prefix + 'regenerate').disabled = true;
    }
    try {
        const invitation = await api('/rooms/' + id + '/invites', 'POST');
        invitations.set(id, invitation);
        if (room?.id === id) {
            showInvite();
        }
    } finally {
        if (room?.id === id) {
            for (const prefix of ['', 'group-']) {
                $(prefix + 'copy').disabled = false;
                $(prefix + 'regenerate').disabled = false;
            }
        }
    }
}

async function copyInvitation(prefix = '') {
    const id = room?.id;
    try {
        let invitation = invitations.get(id);
        if (!invitation || Date.parse(invitation.expiresAt) <= now()) {
            await generateInvite();
            if (room?.id !== id) return;
            invitation = invitations.get(id);
        }
        if (!invitation) return;
        await navigator.clipboard.writeText(location.origin + '/#invite=' + invitation.secret);
        copiedInvitations.set(id + prefix, performance.now() + 3000);
        if (room?.id === id) showInvite();
        toast('Invite link copied. Share it with your friends.');
    } catch (error) {
        if (room?.id !== id) return;
        const invitation = invitations.get(id);
        if (!invitation || Date.parse(invitation.expiresAt) <= now()) {
            fail(error);
            return;
        }
        $(prefix + 'invite-link').focus();
        $(prefix + 'invite-link').select();
        toast('Select and copy the invite link above.');
    }
}
$('copy').onclick = () => copyInvitation();
$('group-copy').onclick = () => copyInvitation('group-');
$('regenerate').onclick = () => generateInvite().catch(fail);
$('group-regenerate').onclick = () => generateInvite().catch(fail);
$('invite-friends').onclick = () => {
    showInvite();
    $('invite-dialog').showModal();
};
$('close-invite').onclick = () => $('invite-dialog').close();
$('members-button').onclick = () => {
    renderMembers();
    $('members-dialog').showModal();
};
$('close-members').onclick = () => $('members-dialog').close();
$('show-details').onclick = () => {
    $('chat-actions').hidePopover();
    $('chat-details').showPopover();
};
$('end').onclick = () => {
    $('chat-actions').hidePopover();
    $('end-dialog').showModal();
};
$('cancel-end').onclick = () => $('end-dialog').close();
$('confirm-end').onclick = async () => {
    try {
        await api('/rooms/' + room.id + '/close', 'POST');
        $('end-dialog').close();
        await reconcile();
        await list();
    } catch (e) {
        fail(e);
    }
};
$('logout').onclick = () => $('logout-dialog').showModal();
$('cancel-logout').onclick = () => $('logout-dialog').close();
$('confirm-logout').onclick = async () => {
    $('confirm-logout').disabled = true;
    try {
        await api('/logout', 'POST');
        expireSession();
    } catch (error) {
        fail(error);
    } finally {
        $('confirm-logout').disabled = false;
    }
};
$('back').onclick = () => {
    $('shell').classList.remove('chat-open');
};
$('draft').oninput = () => {
    rememberDraft();
    controls();
    $('draft').style.height = 'auto';
    $('draft').style.height = Math.min($('draft').scrollHeight, 160) + 'px';
    if (connected && room?.state === 'active' && Date.now() - lastTyping > 2000) {
        lastTyping = Date.now();
        socket.send('typing', { roomId: room.id, typing: !!$('draft').value });
    }
};
$('draft').onkeydown = (e) => {
    if (
        e.key === 'Enter' &&
        !e.shiftKey &&
        !e.isComposing &&
        matchMedia('(pointer:fine)').matches
    ) {
        e.preventDefault();
        if (!$('send').disabled) {
            $('composer').requestSubmit();
        }
    }
};

// Query the canonical operation before retrying; expired accepted sends stay accepted.
function markPendingUncertain() {
    for (const item of pending.values()) {
        clearTimeout(item.timer);
        item.state = 'checking';
        item.verified = false;
    }
}

async function verifyPending(id) {
    const item = pending.get(id);
    if (!item || !me || !connected || !navigator.onLine) return null;
    if (item.checkPromise) return item.checkPromise;
    item.state = 'checking';
    item.verified = false;
    item.checkFailed = false;
    if (room?.id === item.roomId) render();
    item.checkPromise = (async () => {
        try {
            const result = await api(`/rooms/${item.roomId}/operations/${id}`);
            if (pending.get(id) !== item) return null;
            if (result.accepted) {
                acceptPending(id);
                const message = result.message;
                if (
                    room?.id === item.roomId &&
                    message.body &&
                    Date.parse(message.disappearsAt) > now()
                ) {
                    messages.set(message.id, message);
                }
            } else {
                item.state = 'unconfirmed';
                item.verified = true;
            }
            return result;
        } catch (error) {
            if (pending.get(id) !== item) return null;
            if (error.status === 404 || error.status === 410) forgetRoom(item.roomId);
            else {
                item.checkFailed = true;
                if (error.status === 401) fail(error);
            }
            return null;
        } finally {
            item.checkPromise = null;
            if (room?.id === item.roomId) render();
        }
    })();
    return item.checkPromise;
}

function recoverPending(roomId) {
    for (const [id, item] of pending) {
        if ((!roomId || item.roomId === roomId) && item.state !== 'sending') verifyPending(id);
    }
}

function publishPending(id) {
    const item = pending.get(id);
    if (
        !item ||
        !navigator.onLine ||
        !synced ||
        !connected ||
        room?.id !== item.roomId ||
        room.state !== 'active'
    ) {
        if (item) {
            item.state = 'checking';
            if (room?.id === item.roomId) render();
        }
        return;
    }
    clearTimeout(item.timer);
    item.state = 'sending';
    item.verified = false;
    try {
        socket.send('send', { roomId: item.roomId, operationId: id, body: item.body });
        item.timer = setTimeout(() => {
            if (pending.get(id) !== item) return;
            item.state = 'checking';
            verifyPending(id);
            if (room?.id === item.roomId) render();
        }, 8000);
    } catch {
        item.state = 'checking';
        verifyPending(id);
    }
    render();
}

async function retrySend(id) {
    const result = await verifyPending(id);
    if (result && !result.accepted) publishPending(id);
}
$('composer').onsubmit = (event) => {
    event.preventDefault();
    if ($('send').disabled) return;
    const id = crypto.randomUUID();
    pending.set(id, { roomId: room.id, body: $('draft').value, state: 'sending', verified: false });
    drafts.delete(room.id);
    $('draft').value = '';
    $('draft').style.height = 'auto';
    publishPending(id);
    controls();
    $('draft').focus();
    $('messages').scrollTop = $('messages').scrollHeight;
    socket.send('typing', { roomId: room.id, typing: false });
};
$('new-messages').onclick = () => {
    $('messages').scrollTop = $('messages').scrollHeight;
    $('new-messages').hidden = true;
};

// Hide expired text locally between server events and periodic snapshot refreshes.
setInterval(() => {
    // An expired credential may prevent the socket from reconnecting. Clear local text
    // against the server-anchored clock instead of waiting for another HTTP request.
    if (me && serverTimeKnown && Date.parse(me.expiresAt) <= now()) {
        expireSession();
        toast('Your guest session has ended. Choose a name to start again.');
        return;
    }
    let changed = false;
    for (const [id, m] of messages) {
        if (Date.parse(m.disappearsAt) <= now()) {
            messages.delete(id);
            changed = true;
        }
    }
    let backgroundExpired = false;
    for (const state of rooms) {
        if (
            state.id !== room?.id &&
            ['active', 'waiting'].includes(state.state) &&
            Date.parse(state.expiresAt) <= now()
        ) {
            forgetRoom(state.id);
            invitations.delete(state.id);
            unreadRooms.delete(state.id);
            state.state = 'expired';
            backgroundExpired = true;
        }
    }
    if (backgroundExpired) renderRooms();
    if (
        room &&
        !['closed', 'expired'].includes(room.state) &&
        Date.parse(room.expiresAt) <= now()
    ) {
        messages.clear();
        forgetRoom(room.id);
        room.state = 'expired';
        changed = true;
        head();
    }
    if (changed) {
        render();
    }
    for (const el of document.querySelectorAll('[data-deadline]')) {
        updateTimer(el);
    }
    showInvite();
    updateRoomWarning();
    renderReceiptDetails();
}, 250);
setInterval(() => {
    if (document.visibilityState === 'visible' && connected && room) {
        reconcile();
    }
}, 30000);

// Drop stale bodies before restoring a page that was hidden or suspended.
async function foreground() {
    if (document.visibilityState === 'visible' && me) {
        messages.clear();
        render();
        seen.clear();
        delivered.clear();
        await reconcile();
    }
}
window.addEventListener('focus', foreground);
document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        visibility.clear();
        messages.clear();
        $('messages').replaceChildren();
    } else {
        foreground();
    }
});
window.addEventListener('pageshow', (e) => {
    if (e.persisted) {
        foreground();
    }
});
window.addEventListener('offline', () => {
    markPendingUncertain();
    controls();
    if (room) render();
});
window.addEventListener('online', () => {
    controls();
    if (me && connected) {
        recoverPending();
        reconcile();
    }
});
window.addEventListener('hashchange', async () => {
    if (!location.hash.startsWith('#invite=')) return;
    rememberDraft();
    joinSecret = location.hash.slice(8);
    history.replaceState(null, '', location.pathname);
    editingName = false;
    entryReady = false;
    $('shell').hidden = true;
    $('welcome').hidden = false;
    await loadInvitationPreview();
    entryReady = true;
    configureEntry();
});
configureEntry();
try {
    await initCsrf();
    try {
        me = await api('/me');
    } catch (error) {
        if (error.status !== 401) throw error;
    }
    if (joinSecret) await loadInvitationPreview();
    else if (me) await begin();
} catch (error) {
    fail(error);
} finally {
    entryReady = true;
    configureEntry();
}
