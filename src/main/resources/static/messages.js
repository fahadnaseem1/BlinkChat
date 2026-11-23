export function senderColor(id) {
    const hash = Array.from(id).reduce(
        (value, character) => (value * 31 + character.codePointAt(0)) | 0,
        0,
    );
    return `sender-color-${Math.abs(hash) % 6}`;
}

export function renderMessages({
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
    setReceiptMessageId,
    retrySend,
    verifyPending,
}) {
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
    const focusedRow = document.activeElement?.closest('[data-id], [data-pending-id]');
    const focusedId = focusedRow?.dataset.id || focusedRow?.dataset.pendingId;
    const focusedAction = document.activeElement?.dataset.action;
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
            status.dataset.action = 'receipt';
            status.setAttribute('aria-label', `View receipt details: ${receiptLabel(m)}`);
            status.onclick = () => {
                setReceiptMessageId(m.id);
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
        const timer = document.createElement('button');
        timer.className = 'message-timer' + (m.seenAt ? ' expiring' : '');
        timer.dataset.action = 'timer';
        timer.dataset.deadline = m.disappearsAt;
        timer.textContent = `${m.seenAt ? 'Disappears' : 'Unread timer'} in ${remaining(m.disappearsAt)}`;
        timer.onclick = () => {
            setReceiptMessageId(m.id);
            renderReceiptDetails();
            $('receipts-dialog').showModal();
        };
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
        row.dataset.pendingId = id;
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
            retry.dataset.action = 'retry';
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
    if (focusedId) {
        const replacement = [...area.querySelectorAll('[data-id], [data-pending-id]')]
            .find((el) => (el.dataset.id || el.dataset.pendingId) === focusedId)
            ?.querySelector(`[data-action="${focusedAction}"]`);
        (replacement || area).focus({ preventScroll: true });
    }
    renderReceiptDetails();
}
