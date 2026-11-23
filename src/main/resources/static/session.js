export function createSessionMemory({ $, getRoom, drafts, pending }) {
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
        if (getRoom()?.id === roomId) {
            $('draft').value = '';
            $('draft').style.height = 'auto';
        }
    }

    function rememberDraft() {
        if (!getRoom() || !['active', 'waiting'].includes(getRoom().state)) return;
        const room = getRoom();
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

    return { clearPending, forgetRoom, rememberDraft, acceptPending };
}
