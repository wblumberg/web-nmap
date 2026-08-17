import {GEMPAK_TOOLBAR_ICONS} from '../../config/gempakToolbarIcons.generated.js';

function xbmMaskUrl(icon) {
    const bytes = Uint8Array.from(atob(icon.bits), char => char.charCodeAt(0));
    const rowBytes = Math.ceil(icon.width / 8);
    const pixels = [];
    for (let y = 0; y < icon.height; y++) {
        for (let x = 0; x < icon.width; x++) {
            if (bytes[y * rowBytes + Math.floor(x / 8)] & (1 << (x % 8))) {
                pixels.push(`<rect x="${x}" y="${y}" width="1" height="1"/>`);
            }
        }
    }
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${icon.width} ${icon.height}">${pixels.join('')}</svg>`;
    return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

function applyIcon(element, icon) {
    element.style.setProperty('--nawips-icon-mask', xbmMaskUrl(icon));
    element.style.aspectRatio = `${icon.width} / ${icon.height}`;
}

/** Install NAWIPS artwork without replacing button behavior or status children. */
export function installGempakToolbarIcons(root = document) {
    GEMPAK_TOOLBAR_ICONS.forEach(entry => {
        const button = root.getElementById(entry.target);
        if (!button) return;

        // Remove the emoji/text fallback while preserving structured status spans.
        [...button.childNodes].filter(node => node.nodeType === Node.TEXT_NODE).forEach(node => node.remove());
        let iconElement = button.querySelector('.nawips-toolbar-icon');
        if (!iconElement) {
            iconElement = document.createElement('span');
            iconElement.className = 'nawips-toolbar-icon';
            iconElement.setAttribute('aria-hidden', 'true');
            button.prepend(iconElement);
        }
        button.dataset.nawipsIcon = entry.icon.source;
        button.setAttribute('aria-label', button.title || entry.label);

        const refresh = () => {
            const active = entry.activeIcon && button.classList.contains('active');
            const icon = active ? entry.activeIcon : entry.icon;
            applyIcon(iconElement, icon);
            button.dataset.nawipsIcon = icon.source;
        };
        refresh();
        if (entry.activeIcon) {
            new MutationObserver(refresh).observe(button, {attributes: true, attributeFilter: ['class']});
        }
    });
}
