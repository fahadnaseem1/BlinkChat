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
        title.textContent = 'Your chats, for the moment.';
        const description = document.createElement('p');
        description.textContent = 'Start one. Invite someone.';
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
            : 'No messages yet';
        box.append(h);
        if (['closed', 'expired'].includes(room.state)) {
            const p = document.createElement('p');
            p.textContent = 'Start a new chat whenever you like.';
            box.append(p);
        }
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
        const body = document.createElement('button');
        body.type = 'button';
        body.className = 'bubble';
        body.dataset.action = 'details';
        body.title = 'Message details';
        body.onclick = () => {
            setReceiptMessageId(m.id);
            renderReceiptDetails();
            $('receipts-dialog').showModal();
        };
        // Treat message content as plain text, including any HTML-like characters.
        body.textContent = m.body;
        const meta = document.createElement('div');
        meta.className = 'meta';
        const time = document.createElement('time');
        time.dateTime = m.acceptedAt;
        time.textContent = new Date(m.acceptedAt).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
        });
        meta.append(time);
        if (m.senderId === me.id) {
            const total = m.recipientCount || 1;
            const viewed = (m.seenCount || 0) >= total;
            const deliveredToAll = (m.deliveredCount || 0) >= total;
            const receipt = document.createElement('span');
            receipt.className = 'receipt' + (viewed ? ' seen' : '');
            receipt.setAttribute('role', 'img');
            receipt.setAttribute('aria-label', receiptLabel(m));
            receipt.title = receiptLabel(m);
            receipt.textContent = viewed || deliveredToAll ? '✓✓' : '✓';
            meta.append(receipt);
        }
        if (m.senderId !== me.id) {
            const name =
                room.participants.find((p) => p.id === m.senderId)?.displayName || 'Group member';
            row.classList.add('group-message');
            if (!grouped) {
                const author = document.createElement('span');
                author.className = 'message-author';
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
