import { h, render } from 'vue';
import WorkPreview from './components/WorkPreview.vue';

export function mountWorkPreview(root: HTMLElement, work: { video?: string; cover?: string; images: string[] }, isCurrent: () => boolean) {
    render(h(WorkPreview, { video: work.video, cover: work.cover, images: work.images, isCurrent }), root);
    return () => render(null, root);
}
