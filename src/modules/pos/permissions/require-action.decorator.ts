import { SetMetadata } from '@nestjs/common';
import { PosAction } from './permissions.service';

export const POS_ACTION_KEY = 'pos_action';
export const RequirePosAction = (action: PosAction) => SetMetadata(POS_ACTION_KEY, action);
