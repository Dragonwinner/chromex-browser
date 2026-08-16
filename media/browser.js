// ============================================================================
// Full Browser — Webview Client-Side Script
// Handles canvas rendering, input capture, and message passing with extension
// ============================================================================

(function () {
    'use strict';

    // --- VS Code API ---
    // @ts-ignore
    const vscode = acquireVsCodeApi();

    // --- DOM Elements ---
    const canvas = document.getElementById('screencast-canvas');
    const ctx = canvas.getContext('2d');
    const urlInput = document.getElementById('url-input');
    const btnBack = document.getElementById('btn-back');
    const btnForward = document.getElementById('btn-forward');
    const btnReload = document.getElementById('btn-reload');
    const btnHome = document.getElementById('btn-home');
    const btnDevtools = document.getElementById('btn-devtools');
    const btnExternal = document.getElementById('btn-external');
    const loadingBar = document.getElementById('loading-bar');
    const splash = document.getElementById('splash');
    const splashText = document.querySelector('.splash-text');
    const pageTitle = document.getElementById('page-title');
    const statusInfo = document.getElementById('status-info');
    const fpsCounter = document.getElementById('fps-counter');
    const secureIcon = document.getElementById('secure-icon');
    const viewport = document.getElementById('viewport');
    const btnLoginExternal = document.getElementById('btn-login-external');
    const loginBanner = document.getElementById('login-banner');
    const bannerOpenChrome = document.getElementById('banner-open-chrome');
    const bannerClose = document.getElementById('banner-close');

    // --- State ---
    let logicalWidth = 1280;      // Chrome viewport in CSS pixels
    let logicalHeight = 800;
    let screencastWidth = 1280;   // Physical pixels (logical × DPR)
    let screencastHeight = 800;
    let frameCount = 0;
    let lastFpsTime = performance.now();
    let isCanvasFocused = false;
    let resizeTimeout = null;
    let lastFrameImg = null;
    let pendingFrame = null;
    let pendingFormat = 'png';
    let renderScheduled = false;

    // ========================================================================
    // CANVAS SIZING
    // ========================================================================
    function updateCanvasSize() {
        const rect = viewport.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        const w = Math.round(rect.width);
        const h = Math.round(rect.height);

        if (w <= 0 || h <= 0) return;

        // Track logical (CSS) and physical (pixel) dimensions separately
        logicalWidth = w;
        logicalHeight = h;
        screencastWidth = Math.round(w * dpr);
        screencastHeight = Math.round(h * dpr);

        // Canvas internal resolution = physical pixels (sharp on HiDPI)
        canvas.width = screencastWidth;
        canvas.height = screencastHeight;
        // Let CSS width:100%;height:100% handle display sizing

        // Redraw last frame if available
        if (lastFrameImg) {
            ctx.drawImage(lastFrameImg, 0, 0, canvas.width, canvas.height);
        }

        // Tell extension to resize Chrome viewport (send logical + DPR)
        clearTimeout(resizeTimeout);
        resizeTimeout = setTimeout(() => {
            vscode.postMessage({
                type: 'resize',
                width: w,
                height: h,
                dpr: dpr,
            });
        }, 200); // Debounce to avoid excessive restarts
    }

    // Initial sizing
    updateCanvasSize();

    // Resize observer for smooth resizing
    const resizeObserver = new ResizeObserver(() => {
        updateCanvasSize();
    });
    resizeObserver.observe(viewport);

    // ========================================================================
    // SCREENCAST FRAME RENDERING (double-buffered with requestAnimationFrame)
    // ========================================================================
    function scheduleRender() {
        if (renderScheduled) return;
        renderScheduled = true;
        requestAnimationFrame(doRender);
    }

    function doRender() {
        renderScheduled = false;
        if (!pendingFrame) return;

        const img = new Image();
        img.onload = () => {
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            lastFrameImg = img;

            // Hide splash screen on first frame and focus canvas
            if (splash && !splash.classList.contains('hidden')) {
                splash.classList.add('hidden');
                canvas.focus();
            }

            // FPS counter
            frameCount++;
            const now = performance.now();
            if (now - lastFpsTime >= 1000) {
                fpsCounter.textContent = `${frameCount} FPS`;
                frameCount = 0;
                lastFpsTime = now;
            }
        };
        img.src = `data:image/${pendingFormat};base64,` + pendingFrame;
        pendingFrame = null;
    }

    function renderFrame(base64Data, format) {
        // Always keep the latest frame, drop older unrendered ones
        pendingFrame = base64Data;
        pendingFormat = format || 'png';
        scheduleRender();
    }

    // ========================================================================
    // MESSAGE HANDLING (Extension → Webview)
    // ========================================================================
    window.addEventListener('message', (event) => {
        const msg = event.data;

        switch (msg.type) {
            case 'screencastFrame':
                renderFrame(msg.data, msg.format || 'png');
                break;

            case 'urlChanged':
                urlInput.value = msg.url || '';
                statusInfo.textContent = 'Loaded';
                vscode.postMessage({ type: 'checkNavState' });

                // Detect login / authentication pages and display helpful banner
                if (loginBanner) {
                    if (isAuthUrl(msg.url)) {
                        loginBanner.classList.remove('hidden');
                    } else {
                        loginBanner.classList.add('hidden');
                    }
                }
                break;

            case 'titleChanged':
                pageTitle.textContent = msg.title || 'New Tab';
                break;

            case 'loadingChanged':
                if (msg.loading) {
                    loadingBar.classList.add('active');
                    statusInfo.textContent = 'Loading...';
                } else {
                    loadingBar.classList.remove('active');
                    statusInfo.textContent = 'Ready';
                }
                break;

            case 'securityChanged':
                if (msg.secure) {
                    secureIcon.textContent = '🔒';
                    secureIcon.classList.remove('insecure');
                } else {
                    secureIcon.textContent = '⚠️';
                    secureIcon.classList.add('insecure');
                }
                break;

            case 'navState':
                btnBack.disabled = !msg.canGoBack;
                btnForward.disabled = !msg.canGoForward;
                break;

            case 'ready':
                splash.classList.add('hidden');
                canvas.focus();
                break;

            case 'status':
                if (splashText) splashText.textContent = msg.message || '';
                statusInfo.textContent = msg.message || '';
                break;

            case 'error':
                showError(msg.message);
                break;

            case 'cursorChanged':
                canvas.style.cursor = msg.cursor || 'default';
                break;

            case 'zoomChanged':
                if (btnZoomReset) btnZoomReset.textContent = `${msg.zoom}%`;
                if (statusZoom) statusZoom.textContent = `${msg.zoom}%`;
                break;

            case 'consoleMessage':
                // Could display in a mini console panel in future
                break;
        }
    });

    // ========================================================================
    // ERROR DISPLAY
    // ========================================================================
    function showError(message) {
        splash.classList.add('hidden');
        // Remove existing error overlay if any
        const existing = document.querySelector('.error-overlay');
        if (existing) existing.remove();

        const overlay = document.createElement('div');
        overlay.className = 'error-overlay';
        overlay.innerHTML = `
            <div class="error-icon">❌</div>
            <div class="error-text">${escapeHtml(message)}</div>
        `;
        viewport.appendChild(overlay);
    }

    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    // ========================================================================
    // NAVIGATION CONTROLS
    // ========================================================================
    function navigateTo(url) {
        vscode.postMessage({ type: 'navigate', url });
        loadingBar.classList.add('active');
        statusInfo.textContent = 'Navigating...';
    }

    // URL input — Enter to navigate
    urlInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            const url = urlInput.value.trim();
            if (url) {
                navigateTo(url);
                canvas.focus();
            }
        }
        // Ctrl+L to select all in URL bar
        if (e.key === 'l' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            urlInput.select();
        }
        // Stop propagation so keys don't go to Chrome
        e.stopPropagation();
    });

    // Select all text on focus
    urlInput.addEventListener('focus', () => {
        isCanvasFocused = false;
        setTimeout(() => urlInput.select(), 50);
    });

    const btnZoomOut = document.getElementById('btn-zoom-out');
    const btnZoomIn = document.getElementById('btn-zoom-in');
    const btnZoomReset = document.getElementById('btn-zoom-reset');
    const statusZoom = document.getElementById('status-zoom');
    const btnUrlClear = document.getElementById('btn-url-clear');
    const btnHelp = document.getElementById('btn-help');
    const helpModal = document.getElementById('help-modal');
    const helpClose = document.getElementById('help-close');

    // URL clear button toggle
    if (urlInput && btnUrlClear) {
        urlInput.addEventListener('input', () => {
            if (urlInput.value.length > 0) {
                btnUrlClear.classList.remove('hidden');
            } else {
                btnUrlClear.classList.add('hidden');
            }
        });
        btnUrlClear.addEventListener('click', () => {
            urlInput.value = '';
            btnUrlClear.classList.add('hidden');
            urlInput.focus();
        });
    }

    function returnFocusToCanvas(el) {
        if (el && typeof el.blur === 'function') el.blur();
        if (document.activeElement && document.activeElement !== canvas && document.activeElement !== urlInput) {
            document.activeElement.blur();
        }
        canvas.focus();
    }

    // Zoom Controls
    if (btnZoomOut) {
        btnZoomOut.addEventListener('click', (e) => {
            vscode.postMessage({ type: 'zoomOut' });
            returnFocusToCanvas(btnZoomOut);
        });
    }
    if (btnZoomIn) {
        btnZoomIn.addEventListener('click', (e) => {
            vscode.postMessage({ type: 'zoomIn' });
            returnFocusToCanvas(btnZoomIn);
        });
    }
    if (btnZoomReset) {
        btnZoomReset.addEventListener('click', (e) => {
            vscode.postMessage({ type: 'zoomReset' });
            returnFocusToCanvas(btnZoomReset);
        });
    }

    // Help Modal
    if (btnHelp && helpModal && helpClose) {
        btnHelp.addEventListener('click', () => {
            helpModal.classList.remove('hidden');
        });
        helpClose.addEventListener('click', () => {
            helpModal.classList.add('hidden');
            returnFocusToCanvas(helpClose);
        });
        helpModal.addEventListener('click', (e) => {
            if (e.target === helpModal) {
                helpModal.classList.add('hidden');
                returnFocusToCanvas(null);
            }
        });
    }

    // Quick Bookmarks Bar
    const bmItems = document.querySelectorAll('.bm-item');
    bmItems.forEach(item => {
        item.addEventListener('click', () => {
            const url = item.getAttribute('data-url');
            if (url) {
                navigateTo(url);
            }
            returnFocusToCanvas(item);
        });
    });

    // Nav buttons
    btnBack.addEventListener('click', () => {
        vscode.postMessage({ type: 'goBack' });
        returnFocusToCanvas(btnBack);
    });
    btnForward.addEventListener('click', () => {
        vscode.postMessage({ type: 'goForward' });
        returnFocusToCanvas(btnForward);
    });
    btnReload.addEventListener('click', () => {
        vscode.postMessage({ type: 'reload' });
        returnFocusToCanvas(btnReload);
    });
    btnHome.addEventListener('click', () => {
        vscode.postMessage({ type: 'home' });
        returnFocusToCanvas(btnHome);
    });
    if (btnDevtools) {
        btnDevtools.addEventListener('click', () => {
            vscode.postMessage({ type: 'devtools' });
            returnFocusToCanvas(btnDevtools);
        });
    }
    btnExternal.addEventListener('click', () => {
        vscode.postMessage({ type: 'openExternal' });
        returnFocusToCanvas(btnExternal);
    });
    if (btnLoginExternal) {
        btnLoginExternal.addEventListener('click', () => {
            vscode.postMessage({ type: 'loginExternal' });
            returnFocusToCanvas(btnLoginExternal);
        });
    }
    if (bannerOpenChrome) {
        bannerOpenChrome.addEventListener('click', () => {
            vscode.postMessage({ type: 'loginExternal' });
            if (loginBanner) loginBanner.classList.add('hidden');
            returnFocusToCanvas(bannerOpenChrome);
        });
    }
    if (bannerClose) {
        bannerClose.addEventListener('click', () => {
            if (loginBanner) loginBanner.classList.add('hidden');
            returnFocusToCanvas(bannerClose);
        });
    }

    function isAuthUrl(url) {
        if (!url) return false;
        const lower = url.toLowerCase();
        return lower.includes('accounts.google.com') ||
               lower.includes('/signin') ||
               lower.includes('/login') ||
               lower.includes('/get-started') ||
               lower.includes('/signup') ||
               lower.includes('oauth') ||
               lower.includes('auth0') ||
               lower.includes('clerk.') ||
               lower.includes('login.live.com') ||
               lower.includes('login.microsoftonline.com') ||
               lower.includes('appleid.apple.com');
    }

    // ========================================================================
    // MOUSE EVENT FORWARDING (Canvas → CDP)
    // ========================================================================

    function getCanvasCoords(e) {
        const rect = canvas.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return { x: 0, y: 0 };

        // Relative position [0, 1] inside visible canvas area
        const relX = (e.clientX - rect.left) / rect.width;
        const relY = (e.clientY - rect.top) / rect.height;

        // Clamp to [0, 1] for 100% accurate edge and corner targeting
        const clampedX = Math.max(0, Math.min(1, relX));
        const clampedY = Math.max(0, Math.min(1, relY));

        const x = Math.round(clampedX * logicalWidth);
        const y = Math.round(clampedY * logicalHeight);
        return { x, y };
    }

    function getModifiers(e) {
        let mod = 0;
        if (e.altKey) mod |= 1;
        if (e.ctrlKey) mod |= 2;
        if (e.metaKey) mod |= 4;
        if (e.shiftKey) mod |= 8;
        return mod;
    }

    function getButton(e) {
        switch (e.button) {
            case 0: return 'left';
            case 1: return 'middle';
            case 2: return 'right';
            default: return 'left';
        }
    }

    // --- Mouse Down ---
    canvas.addEventListener('mousedown', (e) => {
        e.preventDefault();
        returnFocusToCanvas(null);
        isCanvasFocused = true;
        const { x, y } = getCanvasCoords(e);
        vscode.postMessage({
            type: 'mouseEvent',
            eventType: 'mousePressed',
            x, y,
            button: getButton(e),
            clickCount: e.detail || 1,
            modifiers: getModifiers(e),
        });
    });

    // --- Mouse Up ---
    canvas.addEventListener('mouseup', (e) => {
        e.preventDefault();
        const { x, y } = getCanvasCoords(e);
        vscode.postMessage({
            type: 'mouseEvent',
            eventType: 'mouseReleased',
            x, y,
            button: getButton(e),
            clickCount: e.detail || 1,
            modifiers: getModifiers(e),
        });
    });

    // --- Mouse Move (lightly throttled for smoothness) ---
    let lastMoveTime = 0;
    canvas.addEventListener('mousemove', (e) => {
        const now = performance.now();
        if (now - lastMoveTime < 8) return; // ~120 moves/sec max
        lastMoveTime = now;

        const { x, y } = getCanvasCoords(e);
        vscode.postMessage({
            type: 'mouseEvent',
            eventType: 'mouseMoved',
            x, y,
            button: 'none',
            clickCount: 0,
            modifiers: getModifiers(e),
        });
    });

    // --- Mouse Wheel / Scroll ---
    canvas.addEventListener('wheel', (e) => {
        e.preventDefault();
        const { x, y } = getCanvasCoords(e);
        vscode.postMessage({
            type: 'wheelEvent',
            x, y,
            deltaX: e.deltaX,
            deltaY: e.deltaY,
            modifiers: getModifiers(e),
        });
    }, { passive: false });

    // --- Context Menu (right-click) — prevent default ---
    canvas.addEventListener('contextmenu', (e) => {
        e.preventDefault();
    });

    // ========================================================================
    // KEYBOARD EVENT FORWARDING (Canvas → CDP)
    // ========================================================================

    function handleKeyDown(e) {
        // Don't forward if URL bar is focused
        if (document.activeElement === urlInput) return;

        // Ctrl+L / Cmd+L → focus URL bar
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'l') {
            e.preventDefault();
            urlInput.focus();
            urlInput.select();
            return;
        }

        // Ctrl+ / Ctrl- / Ctrl0 → Zoom
        if (e.ctrlKey || e.metaKey) {
            if (e.key === '=' || e.key === '+') {
                e.preventDefault();
                vscode.postMessage({ type: 'zoomIn' });
                return;
            } else if (e.key === '-') {
                e.preventDefault();
                vscode.postMessage({ type: 'zoomOut' });
                return;
            } else if (e.key === '0') {
                e.preventDefault();
                vscode.postMessage({ type: 'zoomReset' });
                return;
            }
        }

        // Esc → Close Help Modal if open
        if (e.key === 'Escape' && helpModal && !helpModal.classList.contains('hidden')) {
            e.preventDefault();
            helpModal.classList.add('hidden');
            return;
        }

        // F5 → Reload
        if (e.key === 'F5') {
            e.preventDefault();
            vscode.postMessage({ type: 'reload' });
            return;
        }

        // Alt+Left → Back
        if (e.altKey && e.key === 'ArrowLeft') {
            e.preventDefault();
            vscode.postMessage({ type: 'goBack' });
            return;
        }

        // Alt+Right → Forward
        if (e.altKey && e.key === 'ArrowRight') {
            e.preventDefault();
            vscode.postMessage({ type: 'goForward' });
            return;
        }

        e.preventDefault();
        e.stopPropagation();

        const isPrintable = e.key.length === 1 && !e.ctrlKey && !e.metaKey;

        // Send rawKeyDown (NO text for printable chars — the 'char' event handles text insertion)
        vscode.postMessage({
            type: 'keyEvent',
            eventType: 'rawKeyDown',
            key: e.key,
            code: e.code,
            keyCode: e.keyCode,
            modifiers: getModifiers(e),
            text: '',
        });

        // For printable characters, also send a 'char' event
        if (isPrintable) {
            vscode.postMessage({
                type: 'keyEvent',
                eventType: 'char',
                key: e.key,
                code: e.code,
                keyCode: e.key.charCodeAt(0),
                modifiers: getModifiers(e),
                text: e.key,
            });
        }
    }

    function handleKeyUp(e) {
        if (document.activeElement === urlInput) return;

        e.preventDefault();
        e.stopPropagation();

        vscode.postMessage({
            type: 'keyEvent',
            eventType: 'keyUp',
            key: e.key,
            code: e.code,
            keyCode: e.keyCode,
            modifiers: getModifiers(e),
            text: '',
        });
    }

    canvas.addEventListener('keydown', handleKeyDown);
    canvas.addEventListener('keyup', handleKeyUp);
    // NOTE: Do NOT also listen on window — canvas events bubble to window,
    // causing handleKeyDown to fire twice per keypress (double typing).
    // Instead, ensure canvas stays focused so it receives all keyboard events.

    // --- Focus tracking ---
    canvas.addEventListener('focus', () => {
        isCanvasFocused = true;
    });

    canvas.addEventListener('blur', () => {
        isCanvasFocused = false;
    });

    // ========================================================================
    // GLOBAL KEYBOARD SHORTCUTS
    // ========================================================================
    document.addEventListener('keydown', (e) => {
        // Ctrl+L / Cmd+L → Focus URL bar from anywhere
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'l') {
            e.preventDefault();
            urlInput.focus();
            urlInput.select();
        }
    });

    // ========================================================================
    // INITIAL SETUP
    // ========================================================================
    // Focus canvas initially
    canvas.focus();

})();
