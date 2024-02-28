import { lists_index } from "$lib/stores/list_store";
import { trails_show } from "$lib/stores/trail_store";
import { error, type Load } from "@sveltejs/kit";
import { ClientResponseError } from "pocketbase";

export const load: Load = async ({ params }) => {
    try {
        await trails_show(params.id!, true)
    } catch (e) {
        if (e instanceof ClientResponseError && e.status == 404) {
            error(404, {
                message: 'Not found'
            });
        }

    } await lists_index();
};