import { IsInt, IsOptional, Min } from 'class-validator';

export class UndoSplitDto {
  @IsOptional()
  @IsInt()
  @Min(0)
  splitVersion?: number;
}
