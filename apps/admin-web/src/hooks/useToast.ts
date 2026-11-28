import { ref, onBeforeUnmount } from 'vue';

export type ShowToast = (message: string, error?: boolean) => void;

export function useToast() {
    const toast = ref<{ message: string; error: boolean }>();
    let timer: ReturnType<typeof setTimeout> | undefined;

    const showToast: ShowToast = (message, error = false) => {
        clearTimeout(timer);
        toast.value = { message, error };
        timer = setTimeout(() => { toast.value = undefined; }, 3500);
    };

    onBeforeUnmount(() => clearTimeout(timer));
    return { toast, showToast };
}
