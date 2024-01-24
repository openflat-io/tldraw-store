import { InstancePresenceRecordType, computed, createPresenceStateDerivation, createTLStore, defaultShapeUtils, defaultUserPreferences, getUserPreferences, setUserPreferences, react, transact, } from "@tldraw/tldraw";
import { useEffect, useMemo, useState } from "react";
import { YKeyValue } from "y-utility/y-keyvalue";
import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";
import { DEFAULT_STORE } from "./default_store";
export function useYjsStore({ roomId = "example", hostUrl = "wss://demos.yjs.dev", shapeUtils = [], defaultStore = DEFAULT_STORE, }) {
    const [store] = useState(() => {
        const store = createTLStore({
            shapeUtils: [...defaultShapeUtils, ...shapeUtils],
        });
        store.loadSnapshot(defaultStore);
        return store;
    });
    const [storeWithStatus, setStoreWithStatus] = useState({
        status: "loading",
    });
    const { yDoc, yStore, room } = useMemo(() => {
        const yDoc = new Y.Doc({ gc: true });
        const yArr = yDoc.getArray(`tl_${roomId}`);
        const yStore = new YKeyValue(yArr);
        return {
            yDoc,
            yStore,
            room: new WebsocketProvider(hostUrl, roomId, yDoc, { connect: true }),
        };
    }, [hostUrl, roomId]);
    useEffect(() => {
        setStoreWithStatus({ status: "loading" });
        const unsubs = [];
        function handleSync() {
            // 1.
            // Connect store to yjs store and vis versa, for both the document and awareness
            /* -------------------- Document -------------------- */
            // Sync store changes to the yjs doc
            unsubs.push(store.listen(function syncStoreChangesToYjsDoc({ changes }) {
                yDoc.transact(() => {
                    Object.values(changes.added).forEach(record => {
                        yStore.set(record.id, record);
                    });
                    Object.values(changes.updated).forEach(([, record]) => {
                        yStore.set(record.id, record);
                    });
                    Object.values(changes.removed).forEach(record => {
                        yStore.delete(record.id);
                    });
                });
            }, { source: "user", scope: "document" }));
            // Sync the yjs doc changes to the store
            const handleChange = (changes, transaction) => {
                if (transaction.local) {
                    return;
                }
                const toRemove = [];
                const toPut = [];
                changes.forEach((change, id) => {
                    switch (change.action) {
                        case "add":
                        case "update": {
                            const record = yStore.get(id);
                            toPut.push(record);
                            break;
                        }
                        case "delete": {
                            toRemove.push(id);
                            break;
                        }
                    }
                });
                // put / remove the records in the store
                store.mergeRemoteChanges(() => {
                    if (toRemove.length) {
                        store.remove(toRemove);
                    }
                    if (toPut.length) {
                        store.put(toPut);
                    }
                });
            };
            yStore.on("change", handleChange);
            unsubs.push(() => yStore.off("change", handleChange));
            /* -------------------- Awareness ------------------- */
            const yClientId = room.awareness.clientID.toString();
            setUserPreferences({ id: yClientId });
            const userPreferences = computed("userPreferences", () => {
                const user = getUserPreferences();
                return {
                    id: user.id,
                    color: user.color ?? defaultUserPreferences.color,
                    name: user.name ?? defaultUserPreferences.name,
                };
            });
            // Create the instance presence derivation
            const presenceId = InstancePresenceRecordType.createId(yClientId);
            const presenceDerivation = createPresenceStateDerivation(userPreferences, presenceId)(store);
            // Set our initial presence from the derivation's current value
            room.awareness.setLocalStateField("presence", presenceDerivation.get());
            // When the derivation change, sync presence to to yjs awareness
            unsubs.push(react("when presence changes", () => {
                const presence = presenceDerivation.get();
                requestAnimationFrame(() => {
                    room.awareness.setLocalStateField("presence", presence);
                });
            }));
            // Sync yjs awareness changes to the store
            const handleUpdate = (update) => {
                const states = room.awareness.getStates();
                const toRemove = [];
                const toPut = [];
                // Connect records to put / remove
                for (const clientId of update.added) {
                    const state = states.get(clientId);
                    if (state?.presence && state.presence.id !== presenceId) {
                        toPut.push(state.presence);
                    }
                }
                for (const clientId of update.updated) {
                    const state = states.get(clientId);
                    if (state?.presence && state.presence.id !== presenceId) {
                        toPut.push(state.presence);
                    }
                }
                for (const clientId of update.removed) {
                    toRemove.push(InstancePresenceRecordType.createId(clientId.toString()));
                }
                // put / remove the records in the store
                store.mergeRemoteChanges(() => {
                    if (toRemove.length) {
                        store.remove(toRemove);
                    }
                    if (toPut.length) {
                        store.put(toPut);
                    }
                });
            };
            room.awareness.on("update", handleUpdate);
            unsubs.push(() => room.awareness.off("update", handleUpdate));
            // 2.
            // Initialize the store with the yjs doc records—or, if the yjs doc
            // is empty, initialize the yjs doc with the default store records.
            if (yStore.yarray.length) {
                // Replace the store records with the yjs doc records
                transact(() => {
                    // The records here should be compatible with what's in the store
                    store.clear();
                    const records = yStore.yarray.toJSON().map(({ val }) => val);
                    store.put(records);
                });
            }
            else {
                // Create the initial store records
                // Sync the store records to the yjs doc
                yDoc.transact(() => {
                    for (const record of store.allRecords()) {
                        yStore.set(record.id, record);
                    }
                });
            }
            setStoreWithStatus({
                store,
                status: "synced-remote",
                connectionStatus: "online",
            });
        }
        let hasConnectedBefore = false;
        function handleStatusChange({ status }) {
            // If we're disconnected, set the store status to 'synced-remote' and the connection status to 'offline'
            if (status === "disconnected") {
                setStoreWithStatus({
                    store,
                    status: "synced-remote",
                    connectionStatus: "offline",
                });
                return;
            }
            room.off("synced", handleSync);
            if (status === "connected") {
                if (hasConnectedBefore) {
                    return;
                }
                hasConnectedBefore = true;
                room.on("synced", handleSync);
                unsubs.push(() => room.off("synced", handleSync));
            }
        }
        room.on("status", handleStatusChange);
        unsubs.push(() => room.off("status", handleStatusChange));
        return () => {
            unsubs.forEach(fn => fn());
            unsubs.length = 0;
        };
    }, [room, yDoc, store, yStore]);
    return storeWithStatus;
}