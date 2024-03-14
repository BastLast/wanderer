import type { SummitLog } from "$lib/models/summit_log";
import { Trail, type TrailFilter } from "$lib/models/trail";
import type { Waypoint } from "$lib/models/waypoint";
import { pb } from "$lib/pocketbase";
import { getFileURL } from "$lib/util/file_util";
import { util } from "$lib/vendor/svelte-form-lib/util";
import type { LatLng } from "leaflet";
import { ClientResponseError } from "pocketbase";
import { get, writable, type Writable } from "svelte/store";
import { summit_logs_create, summit_logs_delete, summit_logs_update } from "./summit_log_store";
import { waypoints_create, waypoints_delete, waypoints_update } from "./waypoint_store";

export const trails: Writable<Trail[]> = writable([])
export const trail: Writable<Trail> = writable(new Trail(""));

export const editTrail: Writable<Trail> = writable(new Trail(""));

export async function trails_index(data: { perPage: number, random?: boolean, f: (url: RequestInfo | URL, config?: RequestInit) => Promise<Response> } = { perPage: 30, random: false, f: fetch }) {
    const r = await data.f('/api/v1/trail?' + new URLSearchParams({
        "per-page": data.perPage.toString(),
        expand: "category,waypoints,summit_logs",
        sort: data.random ? "@random" : ""
    }), {
        method: 'GET',
    })
    const response = await r.json()

    if (r.ok) {
        trails.set(response.items);
        return response.items;
    } else {
        throw new ClientResponseError(response)
    }
}

export async function trails_search_filter(filter: TrailFilter, page: number = 1, f: (url: RequestInfo | URL, config?: RequestInit) => Promise<Response> = fetch) {
    let filterText: string = `distance >= ${filter.distanceMin} AND distance <= ${filter.distanceMax} AND elevation_gain >= ${filter.elevationGainMin} AND elevation_gain <= ${filter.elevationGainMax}`;

    filterText += ` AND difficulty IN [${filter.difficulty.join(",")}]`

    if (filter.category.length > 0) {
        filterText += ` AND category IN [${filter.category.join(",")}]`;
    }
    if (filter.completed !== undefined) {
        filterText += ` AND completed = ${filter.completed}`;
    }
    if (filter.near.lat && filter.near.lon) {
        filterText += ` AND _geoRadius(${filter.near.lat}, ${filter.near.lon}, ${filter.near.radius})`
    }
    if (filter.near.lat && filter.near.lon) {
        filterText += ` AND _geoRadius(${filter.near.lat}, ${filter.near.lon}, ${filter.near.radius})`
    }
    let r = await f("/api/v1/search/trails", {
        method: "POST",
        body: JSON.stringify({ q: filter.q, options: { filter: filterText, hitsPerPage: 20, page: page } }),
    });

    const result = await r.json();

    if (!r.ok) {
        throw new ClientResponseError(result)
    }

    const trailIds = result.hits.map((h: Record<string, any>) => h.id);

    if (trailIds.length == 0) {
        trails.set([]);
        return [];
    }

    r = await f('/api/v1/trail?' + new URLSearchParams({
        expand: "category,waypoints,summit_logs",
        filter: trailIds.map((id: Record<string, any>) => `id="${id}"`).join('||'),
        sort: `${filter.sortOrder}${filter.sort}`
    }), {
        method: 'GET',
    })
    const response = await r.json()

    if (r.ok) {
        trails.set(response.items);
        return result;
    } else {
        throw new ClientResponseError(response)
    }
}

export async function trails_search_bounding_box(northEast: LatLng, southWest: LatLng, filter?: TrailFilter) {

    let filterText: string = "";

    if (filter) {
        filterText += `distance >= ${filter.distanceMin} AND distance <= ${filter.distanceMax} AND elevation_gain >= ${filter.elevationGainMin} AND elevation_gain <= ${filter.elevationGainMax}`;

        filterText += ` AND difficulty IN [${filter.difficulty.join(",")}]`

        if (filter.category.length > 0) {
            filterText += ` AND category IN [${filter.category.join(",")}]`;
        }
        if (filter.completed !== undefined) {
            filterText += ` AND completed = ${filter.completed}`;
        }
    }

    let r = await fetch("/api/v1/search/trails", {
        method: "POST",
        body: JSON.stringify({
            q: "", options: {
                filter: [
                    `_geoBoundingBox([${northEast.lat}, ${northEast.lng}], [${southWest.lat}, ${southWest.lng}])`,
                    filterText
                ],
            }
        }),
    });
    const result = await r.json();

    const trailIds = result.hits.map((h: Record<string, any>) => h.id);

    if (trailIds.length == 0) {
        const currentTrails: Trail[] = get(trails);
        trails.set([]);
        return compareObjectArrays<Trail>(currentTrails, []);
    }

    r = await fetch('/api/v1/trail?' + new URLSearchParams({
        filter: trailIds.map((id: Record<string, any>) => `id="${id}"`).join("||"),
        expand: "category,waypoints,summit_logs",
        sort: `+name`,
    }), {
        method: 'GET',
    })
    const response = await r.json()

    if (r.ok) {
        for (const trail of response.items) {
            const gpxData: string = await fetchGPX(trail);
            trail.expand.gpx_data = gpxData;
        }

        const comparison = compareObjectArrays<Trail>(get(trails), response.items)

        trails.set(response.items);

        return comparison;
    } else {
        throw new ClientResponseError(response)
    }

}

export async function trails_show(id: string, loadGPX?: boolean, f: (url: RequestInfo | URL, config?: RequestInit) => Promise<Response> = fetch) {
    const r = await f(`/api/v1/trail/${id}?` + new URLSearchParams({
        expand: "category,waypoints,summit_logs",
    }), {
        method: 'GET',
    })
    const response = await r.json()

    if (!r.ok) {
        throw new ClientResponseError(response)
    }

    if (loadGPX) {
        if(!response.expand) {
            response.expand = {}
        }
        const gpxData: string = await fetchGPX(response, f);
        response.expand.gpx_data = gpxData;
    }

    response.expand.waypoints = response.expand.waypoints || [];
    response.expand.summit_logs = response.expand.summit_logs || [];

    trail.set(response);

    return response;
}

export async function trails_create(trail: Trail, photos: File[], gpx: File | null) {

    if (!pb.authStore.model) {
        throw new Error("Unauthenticated");
    }

    for (const waypoint of trail.expand.waypoints) {
        const model = await waypoints_create({
            ...waypoint,
            marker: undefined,
        });
        trail.waypoints.push(model.id!);
    }
    for (const summitLog of trail.expand.summit_logs) {
        const model = await summit_logs_create(summitLog);
        trail.summit_logs.push(model.id!);
    }

    trail.author = pb.authStore.model!.id

    let r = await fetch('/api/v1/trail', {
        method: 'PUT',
        body: JSON.stringify({ ...trail, expand: undefined }),
    })

    if (!r.ok) {
        throw new ClientResponseError(await r.json())
    }

    let model: Trail = await r.json();

    const formData = new FormData()
    if (gpx) {
        formData.append("gpx", gpx);
    }

    for (const photo of photos) {
        formData.append("photos", photo)
    }

    r = await fetch(`/api/v1/trail/${model.id!}/file`, {
        method: 'POST',
        body: formData,
    })

    if (r.ok) {
        return await r.json();
    } else {
        throw new ClientResponseError(await r.json())
    }
}

export async function trails_update(oldTrail: Trail, newTrail: Trail, photos: File[], gpx: File | null) {

    const waypointUpdates = compareObjectArrays<Waypoint>(oldTrail.expand.waypoints ?? [], newTrail.expand.waypoints ?? []);

    for (const addedWaypoint of waypointUpdates.added) {
        const model = await waypoints_create({
            ...addedWaypoint,
            marker: undefined,
        });
        newTrail.waypoints.push(model.id!);
    }

    for (const updatedWaypoint of waypointUpdates.updated) {
        const model = await waypoints_update({
            ...updatedWaypoint,
            marker: undefined,
        });
    }

    for (const deletedWaypoint of waypointUpdates.deleted) {
        const success = await waypoints_delete(deletedWaypoint);
    }

    const summitLogUpdates = compareObjectArrays<SummitLog>(oldTrail.expand.summit_logs ?? [], newTrail.expand.summit_logs ?? []);

    for (const summitLog of summitLogUpdates.added) {
        const model = await summit_logs_create(summitLog);
        newTrail.summit_logs.push(model.id!);
    }

    for (const updatedSummitLog of summitLogUpdates.updated) {
        const model = await summit_logs_update(updatedSummitLog);
    }

    for (const deletedSummitLog of summitLogUpdates.deleted) {
        const success = await summit_logs_delete(deletedSummitLog);
    }

    let r = await fetch('/api/v1/trail/' + newTrail.id, {
        method: 'POST',
        body: JSON.stringify({ ...newTrail, expand: undefined }),
    })

    if (!r.ok) {
        throw new ClientResponseError(await r.json())
    }

    let model: Trail = await r.json();

    const formData = new FormData()
    if (gpx) {
        formData.append("gpx", gpx);
    }

    for (const photo of photos) {
        formData.append("photos", photo)
    }

    const deletedPhotos = oldTrail.photos.filter(oldPhoto => !newTrail.photos.find(newPhoto => newPhoto === oldPhoto));

    for (const deletedPhoto of deletedPhotos) {
        formData.append("photos-", deletedPhoto.replace(/^.*[\\/]/, ''));
    }

    r = await fetch(`/api/v1/trail/${newTrail.id!}/file`, {
        method: 'POST',
        body: formData,
    })

    if (!r.ok) {
        throw new ClientResponseError(await r.json())
    }


    trail.set(model);

    return model;
}


export async function trails_delete(trail: Trail) {
    if (trail.expand.waypoints) {
        for (const waypoint of trail.expand.waypoints) {
            waypoints_delete(waypoint);
        }
    }
    if (trail.expand.summit_logs) {
        for (const summit_log of trail.expand.summit_logs) {
            summit_logs_delete(summit_log);
        }
    }

    const r = await fetch('/api/v1/trail/' + trail.id, {
        method: 'DELETE',
    })

    if (r.ok) {
        return await r.json();
    } else {
        throw new ClientResponseError(await r.json())
    }
}

async function fetchGPX(trail: Trail, f: (url: RequestInfo | URL, config?: RequestInit) => Promise<Response> = fetch) {
    if (!trail.gpx) {
        return "";
    }
    const gpxUrl = getFileURL(trail, trail.gpx);
    const response: Response = await f(gpxUrl);
    const gpxData = await response.text();

    return gpxData
}

function setFileURLs(trail: Trail) {
    for (let i = 0; i < trail.photos.length; i++) {
        const photo = trail.photos[i];
        trail.photos[i] = getFileURL(trail, photo)
    }
}

function compareObjectArrays<T extends { id?: string }>(oldArray: T[], newArray: T[]) {
    const newObjects = [];
    const updatedObjects = [];
    const unchangedObjects = [];
    for (const newObj of newArray) {
        const oldObj = oldArray.find(oldObj => oldObj.id === newObj.id)
        if (!oldObj) {
            newObjects.push(newObj);
        } else if (!util.deepEqual(newObj, oldObj)) {
            updatedObjects.push(newObj);
        } else {
            unchangedObjects.push(newObj);
        }
    }
    const deletedObjects = oldArray.filter(oldObj => !newArray.find(newObj => newObj.id === oldObj.id));

    return {
        added: newObjects,
        deleted: deletedObjects,
        updated: updatedObjects,
        unchanged: unchangedObjects,
    };
}
