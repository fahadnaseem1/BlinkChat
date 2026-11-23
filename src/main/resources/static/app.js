import { createSessionMemory } from './session.js';
import { createRoomMemory, createRoomPresentation } from './room-state.js';
import { renderMessages, senderColor } from './messages.js';
import { createInvitations } from './invitations.js';
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

const { drafts, pending, invitations, copiedInvitations, unreadRooms } = createRoomMemory();
const { chatCode, peerOf, chatLabel, renderRooms } = createRoomPresentation({
    $,
    getRoom: () => room,
    getMe: () => me,
    getRooms: () => rooms,
    unreadRooms,
    open: (id) => open(id),
});
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

const { showInvite, generateInvite } = createInvitations({
    $,
    getRoom: () => room,
    getMe: () => me,
    invitations,
    copiedInvitations,
    now: () => now(),
    remaining,
    api,
    toast,
    fail,
});

// Keep drafts and uncertain sends in memory only; clear their text when the room ends.
const { clearPending, forgetRoom, rememberDraft, acceptPending } = createSessionMemory({
    $,
    getRoom: () => room,
    drafts,
    pending,
});

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
    $('message-announcements').textContent = '';
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
    $('leave-dialog').close();
    receiptMessageId = null;
    $('invite-link').value = '';
    $('group-invite-link').value = '';
    invitations.clear();
    showInvite();
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
        navigator.onLine &&
        connected &&
        synced &&
        !loadingRoom &&
        room?.state === 'active' &&
        room.participants.length >= 2;
    const n = Array.from($('draft').value).length;
    $('draft').disabled = loadingRoom || room?.state !== 'active' || room.participants.length < 2;
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
    $('end').hidden = ended || room.creatorId !== me.id;
    $('leave').hidden = ended;
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
    $('composer-help').textContent =
        room.participants.length < 2
            ? 'Invite someone to continue chatting.'
            : 'A moment shared. Then gone. ◷';
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
    renderMessages({
        $,
        room,
        me,
        messages,
        pending,
        connected,
        synced,
        visibility,
        delivered,
        socket,
        now,
        remaining,
        showCreate,
        receiptLabel,
        renderReceiptDetails,
        setReceiptMessageId: (id) => {
            receiptMessageId = id;
        },
        retrySend,
        verifyPending,
    });
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
    $('message-announcements').textContent = '';
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
            if (e.status === 404) {
                removeLocalRoom(id);
                return;
            }
            if (e.status === 410) {
                messages.clear();
                $('message-announcements').textContent = '';
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
    if (e.type === 'room.left') {
        removeLocalRoom(e.roomId);
        list().catch(fail);
        return;
    }
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
                socket.send('delivered', {
                    roomId: e.roomId,
                    messageId: e.data.id,
                });
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
        $('message-announcements').textContent = '';
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
        if (
            !messages.has(m.id) &&
            m.senderId !== me.id &&
            m.body &&
            Date.parse(m.disappearsAt) > now()
        ) {
            const name =
                room.participants.find((p) => p.id === m.senderId)?.displayName || 'Someone';
            $('message-announcements').textContent =
                `${name} sent a new message. Message ${m.sequence}.`;
        }
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
            const joined = await api('/invites/redeem', 'POST', {
                secret: joinSecret,
            });
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
            readGraceSeconds: Number($('read-grace').value),
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
    if (room) {
        $('ttl').value = String(room.ttlSeconds);
        $('read-grace').value = String(room.readGraceSeconds);
    }
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
function removeLocalRoom(id) {
    forgetRoom(id);
    invitations.delete(id);
    showInvite();
    unreadRooms.delete(id);
    rooms = rooms.filter((r) => r.id !== id);
    if (room?.id === id) {
        generation++;
        room = null;
        messages.clear();
        $('message-announcements').textContent = '';
        seen.clear();
        delivered.clear();
        online = [];
        loadingRoom = false;
        $('typing').textContent = '';
        for (const name of ['leave', 'invite', 'members', 'receipts']) $(name + '-dialog').close();
        $('chat-actions').hidePopover();
        $('chat-details').hidePopover();
        history.replaceState(null, '', location.pathname);
        controls();
        render();
        $('new-room').focus();
    }
    renderRooms();
}
$('leave').onclick = () => {
    $('chat-actions').hidePopover();
    $('leave-owner-note').hidden = room.creatorId !== me.id;
    $('leave-dialog').showModal();
};
$('cancel-leave').onclick = () => $('leave-dialog').close();
$('confirm-leave').onclick = async () => {
    const id = room?.id;
    if (!id) return;
    $('confirm-leave').disabled = true;
    try {
        await api('/rooms/' + id + '/leave', 'POST');
        removeLocalRoom(id);
        await list();
        toast('You left the chat.');
    } catch (e) {
        fail(e);
    } finally {
        $('confirm-leave').disabled = false;
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
        socket.send('send', {
            roomId: item.roomId,
            operationId: id,
            body: item.body,
        });
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
    pending.set(id, {
        roomId: room.id,
        body: $('draft').value,
        state: 'sending',
        verified: false,
    });
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
            $('message-announcements').textContent = '';
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
        $('message-announcements').textContent = '';
        forgetRoom(room.id);
        room.state = 'expired';
        changed = true;
        head();
    }
    if (changed) {
        render();
    }
    for (const timer of $('messages').querySelectorAll('.message-timer')) {
        const label = `${timer.classList.contains('expiring') ? 'Disappears' : 'Unread timer'} in ${remaining(timer.dataset.deadline)}`;
        if (timer.textContent !== label) timer.textContent = label;
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
        $('message-announcements').textContent = '';
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
        $('message-announcements').textContent = '';
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
