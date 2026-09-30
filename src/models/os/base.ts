import { Schema, type SchemaDefinition, type SchemaOptions, type Model } from 'mongoose';
import { tenantModel } from '../../config/tenant.js';
import { RECORD_STATUSES } from '../../shared/constants/os.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type OsDoc = Record<string, any>;

export const { ObjectId } = Schema.Types;

export const str = (extra: Record<string, unknown> = {}) => ({ type: String, default: '', trim: true, ...extra });
export const ref = (model: string, extra: Record<string, unknown> = {}) => ({ type: ObjectId, ref: model, ...extra });
export const oneOf = (values: readonly string[], def: string, extra: Record<string, unknown> = {}) => ({
  type: String, enum: values, default: def, ...extra,
});

export function osSchema(fields: SchemaDefinition, options: SchemaOptions = {}) {
  return new Schema(
    {
      organizationId: { type: ObjectId, ref: 'Organization', required: true, index: true },
      ...fields,
      recordStatus: { type: String, enum: RECORD_STATUSES, default: 'active', index: true },
      createdBy: { type: String, default: '' },
      updatedBy: { type: String, default: '' },
    },
    { timestamps: true, ...options }
  );
}

export function osModel(name: string, schema: Schema): Model<OsDoc> {
  return tenantModel<OsDoc>(name, schema as Schema<OsDoc>);
}
