import {it,expect} from 'vitest';
import {auditChanges} from './auditChanges';
it('keeps only changed fields',()=>{expect(auditChanges({username:'same',priceMonth:'10.00'},{username:'same',priceMonth:'25.00'})).toEqual({priceMonth:{before:'10.00',after:'25.00'}})});
it('represents creation and deletion without inventing old values',()=>{expect(auditChanges(null,{username:'new'})).toEqual({username:{before:null,after:'new'}});expect(auditChanges({username:'old'},null)).toEqual({username:{before:'old',after:null}})});
