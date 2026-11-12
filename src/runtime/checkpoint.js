const CHECKPOINT_TYPES = new Set(["timestamp", "cursor"]);

export function requiresCheckpoint(connector, object) {
  return getCheckpointDefinition(connector, object) !== null;
}

export function hasUsableCheckpoint(connector, object, checkpoint) {
  const definition = getCheckpointDefinition(connector, object);
  if (!definition) return true;

  if (definition.type === "cursor") {
    return typeof checkpoint?.cursor === "string" && Boolean(checkpoint.cursor.trim());
  }
  return Boolean(checkpoint?.lastSuccessfulAt);
}

export function checkpointAfterSuccess(connector, object, lastSuccessfulAt) {
  const definition = getCheckpointDefinition(connector, object);
  if (!definition) return null;

  const checkpoint = {
    checkpointType: definition.type,
    lastSuccessfulAt,
  };

  const nextCheckpoint = connector.getNextCheckpoint?.(object);
  if (nextCheckpoint && typeof nextCheckpoint === "object") {
    Object.assign(checkpoint, nextCheckpoint);
  }

  if (definition.type === "cursor") {
    if (typeof checkpoint.cursor !== "string" || !checkpoint.cursor.trim()) {
      throw new Error(
        `${connector.getConnectorKey?.() || "connector"} did not provide a cursor for ${object}`
      );
    }
  }

  return checkpoint;
}

export function checkpointScope(connector, object) {
  if (typeof connector.getCheckpointScope !== "function") return null;
  const scope = connector.getCheckpointScope(object);
  return typeof scope === "string" && scope.trim() ? scope.trim() : null;
}

function getCheckpointDefinition(connector, object) {
  const definition = connector.getCheckpoint?.(object);
  if (definition === null || definition === undefined) return null;

  const type = definition.type || "timestamp";
  if (!CHECKPOINT_TYPES.has(type)) {
    throw new Error(`Unsupported checkpoint type "${type}" for ${object}`);
  }
  return { ...definition, type };
}
