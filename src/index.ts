import * as Y from "yjs";
import { v4 as uuid, NIL } from "uuid";

function mapRecord<T, U>(func: (t: T, k: string, obj: Record<string, T>) => U, obj: Record<string, T>): Record<string, U> {
    return Object.keys(obj).reduce((m, k) => Object.assign(m, {
        [k]: func(obj[k], k, obj),
    }), {});
}

type DocInfo = {
    doc: Y.Doc;
    schema: Record<string, Record<string, string>>;
};

type RecordInfo = {
    id: string;
    type: string;
    recordSchema: Record<string, string>;
    record: Y.Map<any>;
    updateHandler: (evt: Y.YMapEvent<any>) => void;
    watchers: Set<() => void>;
};

type Schema<T extends {}> = {
    [K in keyof T]: RecordType<T>;
};

type FieldType<T extends {}> = 'string' | 'number' | 'boolean' | keyof T & string;

type RecordType<T extends {}> = Record<string, FieldType<T>>;

type M<T extends {}, S extends Schema<T>> = {
    [K in keyof S]: {
        [L in keyof S[K]]: 
            S[K][L] extends 'string' ? string :
            S[K][L] extends 'number' ? string :
            S[K][L] extends 'boolean' ? boolean :
            S[K][L] extends keyof S ? M<T, S>[S[K][L]] | null : never;
    }
};

type N<T extends {}, S extends Schema<T>> = {
    [K in keyof S]: (rec: M<T, S>[K]) => M<T, S>[K];
};

const docInfoMap: WeakMap<Y.Doc, DocInfo> = new WeakMap();
const delegateMap: WeakMap<Y.Map<any>, Object> = new WeakMap();
const recordInfoMap: WeakMap<Object, RecordInfo> = new WeakMap();

function getDelegate(doc: Y.Doc, id: string): Object | null {
    const schema = docInfoMap.get(doc)?.schema ?? null;
    if (schema === null) {
        return null;
    }

    const record = doc.getMap<Y.Map<any>>('objects')?.get(id) ?? null;
    if (record === null) {
        return null;
    }

    if (!delegateMap.has(record)) {
        const type = record.get('@type');
        const timestamp = record.get('@timestamp');

        if (typeof type !== 'string' || typeof timestamp !== 'number') {
            return null;
        }

        const recordSchema = schema[type];
        if (typeof recordSchema !== 'object') {
            return null;
        }

        const shadow: any = {};

        const delegate = new Proxy(shadow, {
            has(_, prop) {
                return prop in recordSchema;
            },
            get(target, prop, receiver) {
                if (typeof prop === 'string' && prop in recordSchema) {
                    if (!Reflect.has(target, prop)) {
                        const ty = recordSchema[prop];
                        const val = ty === 'string' || ty === 'number' || ty === 'boolean'
                            ? record.get(prop)
                            : getDelegate(doc, record.get(prop));
                        Reflect.set(target, prop, val, receiver);
                    }
                    return Reflect.get(target, prop, receiver);
                }
                return undefined;
            },
            set(target, prop, value, receiver): boolean {
                if (typeof prop === 'string' && prop in recordSchema) {
                    const ty = recordSchema[prop];
                    if (ty === 'string' || ty === 'number' || ty === 'boolean' && typeof value === ty) {
                        doc.transact(() => {
                            record.set(prop, value);
                            record.set('@timestamp', Date.now());
                        });
                    } else if (ty in schema) {
                        if (value === null) {
                            doc.transact(() => {
                                record.set(prop, NIL);
                                record.set('@timestamp', Date.now());
                            });
                        }
                        const info = recordInfoMap.get(value);
                        if (!info || info.type !== ty) {
                            return false;
                        }
                        doc.transact(() => {
                            record.set(prop, info.id);
                            record.set('@timestamp', Date.now());
                        });
                    }
                    Reflect.set(target, prop, value, receiver);
                    return true;
                }
                return false;
            },
        });

        const updateHandler = (evt: Y.YMapEvent<any>) => {
            if (evt.keysChanged.size > 0) {
                evt.keysChanged.forEach(prop => {
                    prop in recordSchema ?? delete shadow[prop];
                });
                recordInfo.watchers.forEach(cb => cb());
                recordInfo.watchers = new Set();
            }
        };

        const recordInfo: RecordInfo = {
            id,
            type,
            recordSchema,
            record,
            updateHandler,
            watchers: new Set(),
        };

        record.observe(updateHandler);

        recordInfoMap.set(delegate, recordInfo);
        delegateMap.set(record, delegate);
    }

    return delegateMap.get(record) || null;
}

export function isValid(obj: Object): boolean {
    const recInfo = recordInfoMap.get(obj);
    if (!recInfo) {
        return false;
    }
    const { id, record } = recInfo;
    return record.doc?.getMap('objects').get(id) === record;
}

export function remove(obj: Object): boolean {
    const recInfo = recordInfoMap.get(obj);
    if (!recInfo) {
        return false;
    }
    const { id, record, updateHandler } = recInfo;
    const objects = record.doc?.getMap('objects');
    if (objects?.get(id) === record) {
        record.unobserve(updateHandler);
        objects.delete(id);
        recordInfoMap.delete(obj);
        delegateMap.delete(record)
        return true;
    }
    return false;
}

export function watch(obj: Object, cb: () => void): () => void {
    const recInfo = recordInfoMap.get(obj);
    if (!recInfo) {
        throw new Error('Cannot watch');
    }
    const { watchers } = recInfo;
    watchers.add(cb);
    return () => watchers.delete(cb);
}

function assignField(record: Y.Map<any>, field: string, type: string, val: any): boolean {
    const { doc } = record;
    const doAssign = doc
        ? (fieldVal: any) => doc.transact(() => {
            record.set(field, fieldVal);
            record.set('@timestamp', Date.now());
        })
        : (fieldVal: any) => record.set(field, fieldVal);

    if (type === 'string' || type === 'number' || type === 'boolean') {
        if (typeof val === type) {
            doAssign(val);
            return true;
        }
    } else if (val === null) {
        doAssign(NIL);
        return true;
    } else {
        const info = recordInfoMap.get(record);
        if (info && info.type === type) {
            doAssign(info.id);
            return true;
        }
    }
    return false;
}

export function create<T extends {}, S extends Schema<T>>(s: S): N<T, S> {
    const doc = new Y.Doc();
    return mapRecord((recordSchema: RecordType<T>) => (rec: any) => {
        const id = uuid();
        const record = new Y.Map();
        Object.entries(recordSchema).forEach(([field, type]) => {
            if (! assignField(record, field, type, rec[field])) {
                throw new Error('Incorrect parameter type');
            }
        });
        doc.getMap('objects').set(id, record);
        return getDelegate(doc, id);
    }, s) as N<T, S>;
}
