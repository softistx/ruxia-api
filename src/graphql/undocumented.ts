import { type DocumentNode, parse, visit } from "graphql";

type Described = { description?: { value: string } | undefined };

// Every coordinate (`Type`, `Type.field`, `Type.field(arg:)`, `Enum.VALUE`) of
// an SDL document that has no description, in source order. Extensions
// (`extend type`) add to a definition the base one documents, so only the
// fields they declare are checked, not the extension itself.
export function undocumentedCoordinates(document: DocumentNode): string[] {
  const missing: string[] = [];
  const types: string[] = [];
  const fields: string[] = [];
  const need = (node: Described, coordinate: string) => {
    if (!node.description?.value.trim()) missing.push(coordinate);
  };
  const enter = (node: Described & { name: { value: string } }) => {
    types.push(node.name.value);
    need(node, node.name.value);
  };
  const enterExtension = (node: { name: { value: string } }) => {
    types.push(node.name.value);
  };
  const leave = () => {
    types.pop();
  };
  visit(document, {
    ScalarTypeDefinition: { enter, leave },
    ObjectTypeDefinition: { enter, leave },
    InterfaceTypeDefinition: { enter, leave },
    UnionTypeDefinition: { enter, leave },
    EnumTypeDefinition: { enter, leave },
    InputObjectTypeDefinition: { enter, leave },
    ObjectTypeExtension: { enter: enterExtension, leave },
    InterfaceTypeExtension: { enter: enterExtension, leave },
    EnumTypeExtension: { enter: enterExtension, leave },
    InputObjectTypeExtension: { enter: enterExtension, leave },
    UnionTypeExtension: { enter: enterExtension, leave },
    DirectiveDefinition: {
      enter(node) {
        types.push(`@${node.name.value}`);
        need(node, `@${node.name.value}`);
      },
      leave,
    },
    FieldDefinition: {
      enter(node) {
        const coordinate = `${types.at(-1)}.${node.name.value}`;
        fields.push(coordinate);
        need(node, coordinate);
      },
      leave() {
        fields.pop();
      },
    },
    InputValueDefinition(node) {
      const parent = fields.at(-1) ?? types.at(-1);
      const coordinate =
        fields.length || types.at(-1)?.startsWith("@")
          ? `${parent}(${node.name.value}:)`
          : `${parent}.${node.name.value}`;
      need(node, coordinate);
    },
    EnumValueDefinition(node) {
      need(node, `${types.at(-1)}.${node.name.value}`);
    },
  });
  return missing;
}

export function undocumentedInSdl(sdl: string): string[] {
  return undocumentedCoordinates(parse(sdl, { noLocation: true }));
}
