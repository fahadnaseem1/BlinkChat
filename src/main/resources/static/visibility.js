// Count a view after 500 ms of visible content in a focused foreground page.
export function observeVisible(root, callback) {
    const timers = new Map();
    const observer = new IntersectionObserver(
        (entries) => {
            for (const e of entries) {
                const id = e.target.dataset.id;
                clearTimeout(timers.get(id));
                if (
                    e.isIntersecting &&
                    e.intersectionRect.height >= Math.min(24, e.boundingClientRect.height) &&
                    document.visibilityState === 'visible' &&
                    document.hasFocus()
                ) {
                    timers.set(
                        id,
                        setTimeout(() => {
                            if (
                                document.visibilityState === 'visible' &&
                                document.hasFocus() &&
                                e.target.isConnected
                            ) {
                                callback(id);
                            }
                        }, 500),
                    );
                }
            }
        },
        { root, threshold: [0, 0.01, 1] },
    );
    return {
        watch(el) {
            observer.observe(el);
        },
        clear() {
            observer.disconnect();
            for (const timer of timers.values()) {
                clearTimeout(timer);
            }
            timers.clear();
        },
    };
}
